import { createTransactionStore } from "./store.js";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import config from "../../config/index.js";
import { DatabaseError as PostgresError, type PoolClient, type QueryResult } from "pg";
import { queryConnectionError, queryExecutionError } from "../../utils/query-pool.js";
import { createResultBudget, losslessTypes, watchExecution, type ResultStatement } from "../query/execution.js";
import { formatQueryResult } from "../query/index.js";
import { beginStatement, transactionOptions, type TransactionOptions } from "../query/options.js";

interface QueuedQuery {
  queryId: string;
  query: string;
  serializedParameters: string;
  bytes: number;
}

interface Transaction {
  transactionId: string;
  database: string;
  databaseOid: string;
  owner: string;
  status: "pending" | "committing" | "committed" | "failed";
  queries: Map<string, QueuedQuery>;
  bytes: number;
  expiresAt: number;
  options: TransactionOptions;
}

interface TransactionBody {
  query?: unknown;
  parameters?: unknown;
  params?: unknown;
  queryId?: unknown;
  options?: unknown;
}

const transactionCommands = new Set([
  "ABORT", "BEGIN", "COMMIT", "END", "PREPARE", "RELEASE", "ROLLBACK", "SAVEPOINT", "START",
]);
const retentionMs = 15 * 60_000;
const maxTransactions = 1_000;
const maxQueriesPerTransaction = 100;
const maxTransactionBytes = 256 * 1024;
const maxStoredBytes = 16 * 1024 * 1024;
const transactionOverhead = 1024;
const queryOverhead = 512;

function hasTransactionModes(options: TransactionOptions) {
  return options.isolationLevel !== undefined || options.readOnly !== undefined || options.deferrable !== undefined;
}

function canQueue(sql: string, options: TransactionOptions) {
  // Match a whole SQL identifier so transaction keywords cannot be disguised by a partial match.
  const command = /^[a-z]+[a-z0-9_$]*/i.exec(sql.trim())?.[0].toUpperCase();
  if (!command || transactionCommands.has(command)) return false;
  return !hasTransactionModes(options) || (command !== "SET" && command !== "RESET");
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ success: false, error: { code, message } });
}

const transactionRoutes: FastifyPluginAsync = async (fastify) => {
  const store = createTransactionStore(fastify.db);
  const activeBatches = new Set<Promise<void>>();
  let batchSlots = 0;
  const { retentionDays } = config.transactions;
  let pruning: Promise<void> | undefined;
  let pruneTimer: NodeJS.Timeout | undefined;
  let closing = false;
  function schedulePrune(waitMs: number) {
    if (closing || retentionDays === 0) return;
    pruneTimer = setTimeout(() => {
      let nextDelay = 60 * 60_000;
      pruning = store.prune(retentionDays).then((more) => {
        if (more) nextDelay = 1_000;
      }).catch((err) => {
        fastify.log.error({ err }, "Could not prune expired transaction records");
      }).finally(() => {
        pruning = undefined;
        schedulePrune(nextDelay);
      });
    }, waitMs).unref();
  }
  schedulePrune(0);
  fastify.addHook("onClose", async () => {
    closing = true;
    clearTimeout(pruneTimer);
    await Promise.allSettled([...activeBatches, pruning]);
  });
  const transactions = new Map<string, Transaction>();
  const queryTransactions = new Map<string, string>();
  let storedBytes = 0;

  function removeTransaction(transaction: Transaction) {
    for (const queryId of transaction.queries.keys()) queryTransactions.delete(queryId);
    transactions.delete(transaction.transactionId);
    storedBytes -= transaction.bytes;
  }

  function cleanupExpired() {
    const now = Date.now();
    for (const transaction of transactions.values()) {
      if (transaction.status !== "committing" && transaction.expiresAt <= now) {
        removeTransaction(transaction);
      }
    }
  }

  const cleanupTimer = setInterval(cleanupExpired, 60_000).unref();
  fastify.addHook("onClose", async () => clearInterval(cleanupTimer));

  function findTransaction(request: FastifyRequest, id: string) {
    const transaction = transactions.get(id);
    if (!transaction) return;
    if (transaction.status !== "committing" && transaction.expiresAt <= Date.now()) {
      removeTransaction(transaction);
      return;
    }
    if (transaction.owner === request.apiKey?.id && transaction.database === request.database &&
      transaction.databaseOid === request.databaseOid) {
      return transaction;
    }
  }

  function transactionHeader(request: FastifyRequest, reply: FastifyReply) {
    const id = request.headers["transaction-id"] ?? request.headers["x-transaction-id"];
    if (typeof id !== "string" || !id) {
      fail(reply, 400, "TRANSACTION_ID_REQUIRED", "The transaction-id header is required");
      return;
    }
    return id;
  }

  function storedTransaction(request: FastifyRequest, id: string) {
    return store.get(id, request.apiKey?.id ?? "", request.databaseOid);
  }

  async function requireTransaction(request: FastifyRequest, reply: FastifyReply) {
    const id = transactionHeader(request, reply);
    if (!id) return;
    const transaction = findTransaction(request, id);
    if (transaction) return transaction;
    try {
      if (await storedTransaction(request, id)) {
        fail(reply, 409, "TRANSACTION_ALREADY_SUBMITTED", "An execute batch cannot be edited or committed again");
        return;
      }
    } catch (error) {
      request.log.error({ err: error }, "Could not read transaction status");
      fail(reply, 503, "TRANSACTION_STORE_UNAVAILABLE", "Could not read transaction status");
      return;
    }
    fail(reply, 404, "TRANSACTION_NOT_FOUND", "Transaction not found");
  }

  function create(request: FastifyRequest<{ Body: TransactionBody }>, reply: FastifyReply) {
    if (!request.apiKey || !request.databaseOid) {
      return fail(reply, 401, "UNAUTHORIZED", "A database-scoped API key is required");
    }
    const options = transactionOptions.safeParse(request.body?.options === undefined ? {} : request.body.options);
    if (!options.success) return fail(reply, 400, "INVALID_OPTIONS", "Invalid transaction options");
    if (transactions.size >= maxTransactions || storedBytes + transactionOverhead > maxStoredBytes) {
      cleanupExpired();
      if (transactions.size >= maxTransactions || storedBytes + transactionOverhead > maxStoredBytes) {
        return fail(reply, 429, "TRANSACTION_LIMIT_EXCEEDED", "Too many stored transactions");
      }
    }
    const transactionId = randomUUID();
    transactions.set(transactionId, {
      transactionId,
      database: request.database,
      databaseOid: request.databaseOid,
      owner: request.apiKey.id,
      status: "pending",
      queries: new Map(),
      bytes: transactionOverhead,
      expiresAt: Date.now() + retentionMs,
      options: options.data,
    });
    storedBytes += transactionOverhead;
    return reply.code(201).send({ success: true, transactionId });
  }

  async function commit(
    transaction: Transaction,
    scopes: FastifyRequest["queryScopes"],
    reply?: FastifyReply,
    progress?: {
      completed: (count: number) => Promise<void>;
      committing: (outcome: { status: number; payload: object }) => Promise<void>;
    },
  ) {
    const immediate = !reply;
    const respond = (status: number, payload: object) => ({ status, payload });
    const failure = (status: number, code: string, message: string) =>
      respond(status, { success: false, error: { code, message } });
    const execution = watchExecution(reply, 60_000, fastify.queryPools.queryDispatched);
    let storeFailed = false;
    async function saveProgress(operation: Promise<void>) {
      try {
        await execution.wait(operation);
      } catch (error) {
        storeFailed = !execution.stopped;
        throw error;
      }
    }
    const resultBudget = createResultBudget(execution);
    transaction.status = "committing";
    let client: PoolClient | undefined;
    let commitSent = false;
    let queryId: string | undefined;
    try {
      const acquired = await execution.wait(fastify.queryPools.connect(transaction.database, transaction.databaseOid, scopes).then((connection) => {
        execution.attach(connection);
        return connection;
      }));
      client = acquired;
      await execution.run(() => acquired.query(beginStatement(transaction.options)));
      execution.check();
      // Establish the snapshot before user SQL can try to change isolation or enable writes.
      if (hasTransactionModes(transaction.options)) await execution.run(() => acquired.query("SELECT 1"));
      const results = [];
      for (const queued of transaction.queries.values()) {
        execution.check();
        queryId = queued.queryId;
        // The extended protocol permits one SQL statement per queued query.
        const statement: ResultStatement = {
          text: queued.query,
          types: transaction.options.lossless === false ? undefined : losslessTypes,
          values: JSON.parse(queued.serializedParameters),
          queryMode: "extended",
          rowMode: transaction.options.arrayMode ? "array" : undefined,
        };
        const result = await execution.run(() => resultBudget.query(acquired, statement)) as QueryResult;
        results.push({ ...(immediate ? { queryIndex: results.length } : { queryId }), ...formatQueryResult(result, transaction.options.fullResults) });
        queryId = undefined;
        if (progress) await saveProgress(progress.completed(results.length));
      }
      execution.check();
      queryId = undefined;
      const outcome = respond(200, { success: true, transactionId: transaction.transactionId, results });
      if (progress) await saveProgress(progress.committing(outcome));
      const result = await execution.run(() => {
        commitSent = true;
        return acquired.query("COMMIT");
      });
      if (result.command === "ROLLBACK") {
        transaction.status = "pending";
        return failure(400, "TRANSACTION_ROLLED_BACK", "PostgreSQL rolled back the transaction");
      }
      if (result.command !== "COMMIT") throw new Error("Unexpected PostgreSQL COMMIT result");
      transaction.status = "committed";
      return outcome;
    } catch (error) {
      if (commitSent) {
        // A server ErrorResponse to COMMIT rejects it. A fatal or transport error may lose its reply.
        if (error instanceof PostgresError && error.severity === "ERROR") {
          transaction.status = "pending";
          return respond(400, {
            success: false,
            error: {
              ...queryExecutionError(error).error,
              code: "TRANSACTION_ROLLED_BACK",
            },
          });
        }
        transaction.status = "failed";
        fastify.log.error({ err: error, transactionId: transaction.transactionId }, "Commit could not be confirmed");
        return failure(500, "TRANSACTION_COMMIT_FAILED", "The commit could not be confirmed");
      }
      const acquired = client;
      if (acquired && !execution.stopped) {
        try {
          await execution.run(() => acquired.query("ROLLBACK"));
        } catch (rollbackError) {
          fastify.log.error({ err: rollbackError }, "Failed to roll back transaction");
        }
      }
      transaction.status = "pending";
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return failure(status, code, message);
      }
      if (storeFailed) {
        fastify.log.error({ err: error, transactionId: transaction.transactionId }, "Could not update transaction progress");
        return failure(503, "TRANSACTION_STORE_UNAVAILABLE", "Could not update transaction progress");
      }
      if (!client) {
        const { status, code, message } = queryConnectionError(error);
        if (status === 503) fastify.log.error({ err: error }, "Failed to open transaction connection");
        return failure(status, code, message);
      }
      if (queryId) {
        const result = queryExecutionError(error);
        return respond(result.status, { success: false, error: { ...result.error, ...(immediate ? { queryIndex: Number(queryId) } : { queryId }) } });
      }
      if (error instanceof PostgresError) {
        const result = queryExecutionError(error);
        return respond(error.code === "57014" ? 504 : 503, {
          success: false, error: { ...result.error, code: "TRANSACTION_UNAVAILABLE" },
        });
      }
      fastify.log.error({ err: error }, "Failed to start transaction");
      return failure(503, "TRANSACTION_UNAVAILABLE", "Could not start the PostgreSQL transaction");
    } finally {
      // Discard session-level changes made by queued SQL.
      execution.close();
      transaction.expiresAt = Date.now() + retentionMs;
    }
  }

  fastify.post<{ Body: { queries?: unknown; options?: unknown } }>("/execute", async (request, reply) => {
    if (!request.apiKey || !request.databaseOid) {
      return fail(reply, 401, "UNAUTHORIZED", "A database-scoped API key is required");
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (idempotencyKey !== undefined &&
        (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey))) {
      return fail(reply, 400, "INVALID_IDEMPOTENCY_KEY", "Use 1 to 128 letters, digits, or . _ ~ - in Idempotency-Key");
    }
    const { queries: input, options } = request.body ?? {};
    let queries = Array.isArray(input) ? input.map((item) => typeof item === "string" ? { query: item } : item) : undefined;
    const first = queries?.[0];
    const last = queries?.at(-1);
    if (queries && typeof first?.query === "string" && /^BEGIN\s*;?$/i.test(first.query.trim()) &&
        typeof last?.query === "string" && /^COMMIT\s*;?$/i.test(last.query.trim()) &&
        [first, last].every((marker) => marker.parameters === undefined && marker.params === undefined)) {
      queries = queries.slice(1, -1);
    }
    const parsed = transactionOptions.safeParse(options === undefined ? {} : options);
    if (!parsed.success) return fail(reply, 400, "INVALID_OPTIONS", "Invalid transaction options");
    if (!Array.isArray(queries) || queries.length === 0 || queries.length > maxQueriesPerTransaction) {
      return fail(reply, 400, "INVALID_QUERIES", "Provide between 1 and 100 queries");
    }

    const transaction: Transaction = {
      transactionId: randomUUID(),
      database: request.database,
      databaseOid: request.databaseOid,
      owner: request.apiKey.id,
      status: "pending",
      queries: new Map(),
      bytes: transactionOverhead,
      expiresAt: 0,
      options: parsed.data,
    };
    for (const [index, statement] of queries.entries()) {
      const sql = statement?.query;
      const parameters = statement?.parameters !== undefined ? statement.parameters : statement?.params;
      if (typeof sql !== "string" || !canQueue(sql, parsed.data)) {
        return fail(reply, 400, "INVALID_QUERY", `Invalid transaction statement at index ${index}`);
      }
      if (parameters !== undefined && !Array.isArray(parameters)) {
        return fail(reply, 400, "INVALID_PARAMETERS", `Query parameters at index ${index} must be an array`);
      }
      const serializedParameters = JSON.stringify(parameters ?? []);
      const bytes = queryOverhead + 2 * (sql.length + serializedParameters.length);
      transaction.bytes += bytes;
      if (transaction.bytes > maxTransactionBytes) {
        return fail(reply, 413, "TRANSACTION_QUEUE_LIMIT_EXCEEDED", "The transaction exceeds its size limit");
      }
      const queryId = String(index);
      transaction.queries.set(queryId, { queryId, query: sql, serializedParameters, bytes });
    }
    const batchInput = {
      queries: [...transaction.queries.values()].map(({ query, serializedParameters }) => ({
        query, parameters: JSON.parse(serializedParameters),
      })),
      options: transaction.options,
    };
    function accept(id: string) {
      return reply.header("Location", `/transaction/${id}`).code(202).send({
        success: true, transactionId: id, status: "pending",
      });
    }
    function replay({ id, matches }: { id: string; matches: boolean }) {
      return matches ? accept(id) :
        fail(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "This key already belongs to a different batch");
    }
    let reserved = false;
    const transactionId = transaction.transactionId;
    try {
      if (batchSlots >= 32) {
        if (idempotencyKey) {
          const existing = await store.getSubmission(transaction.owner, transaction.databaseOid, idempotencyKey, batchInput);
          if (existing) return replay(existing);
        }
        return fail(reply, 503, "TRANSACTION_QUEUE_FULL", "Too many transactions are running");
      }
      batchSlots++;
      reserved = true;
      const submission = await store.create(
        transactionId, transaction.owner, transaction.database, transaction.databaseOid, batchInput, idempotencyKey,
      );
      if (!submission.created) {
        reserved = false;
        batchSlots--;
        return replay(submission);
      }
    } catch (error) {
      if (reserved) batchSlots--;
      request.log.error({ err: error }, "Could not save transaction");
      return fail(reply, 503, "TRANSACTION_STORE_UNAVAILABLE", "Could not save transaction");
    }

    const scopes = request.queryScopes;
    const batch = (async () => {
      try {
        await store.advance(transactionId, "pending", "running");
        const outcome = await commit(transaction, scopes, undefined, {
          completed: (count) => store.advance(transactionId, "running", "running", count),
          committing: (outcome) => store.advance(transactionId, "running", "committing", undefined, outcome),
        });
        const status = transaction.status === "committed" ? "committed" :
          transaction.status === "failed" ? "unknown" : outcome.status < 500 ? "rejected" : "failed";
        await store.finish(transactionId, status, status === "committed" ? undefined : outcome);
      } catch (error) {
        // Leave the stored phase intact when writing the final outcome fails.
        request.log.error({ err: error, transactionId }, "Could not record transaction outcome");
      }
    })();
    activeBatches.add(batch);
    void batch.finally(() => {
      activeBatches.delete(batch);
      batchSlots--;
    });
    return accept(transactionId);
  });

  fastify.post("/", create);
  fastify.post("/create", create);

  fastify.post<{ Body: TransactionBody | string }>("/add", async (request, reply) => {
    const transaction = await requireTransaction(request, reply);
    if (!transaction) return;
    if (transaction.status !== "pending") {
      return fail(reply, 409, "TRANSACTION_NOT_PENDING", "Transaction is no longer pending");
    }

    const body = typeof request.body === "string" ? { query: request.body } : request.body;
    const sql = body?.query;
    if (typeof sql !== "string" || !sql.trim()) {
      return fail(reply, 400, "INVALID_QUERY", "A SQL query is required");
    }
    const parameters = body?.parameters !== undefined ? body.parameters : body?.params;
    if (parameters !== undefined && !Array.isArray(parameters)) {
      return fail(reply, 400, "INVALID_PARAMETERS", "Query parameters must be an array");
    }
    if (/^COMMIT\s*;?$/i.test(sql.trim())) {
      if (parameters?.length) {
        return fail(reply, 400, "INVALID_PARAMETERS", "COMMIT takes no parameters");
      }
      const outcome = await commit(transaction, request.queryScopes, reply);
      return reply.code(outcome.status).send(outcome.payload);
    }

    if (!canQueue(sql, transaction.options)) {
      return fail(reply, 400, "INVALID_QUERY", "Start with a SQL command other than transaction control");
    }
    const serializedParameters = JSON.stringify(parameters ?? []);
    const bytes = queryOverhead + 2 * (sql.length + serializedParameters.length);
    if (transaction.queries.size >= maxQueriesPerTransaction || transaction.bytes + bytes > maxTransactionBytes) {
      return fail(reply, 413, "TRANSACTION_QUEUE_LIMIT_EXCEEDED", "The transaction queue exceeds its size limit");
    }
    if (storedBytes + bytes > maxStoredBytes) {
      cleanupExpired();
      if (!transactions.has(transaction.transactionId)) {
        return fail(reply, 404, "TRANSACTION_NOT_FOUND", "Transaction not found");
      }
      if (storedBytes + bytes > maxStoredBytes) {
        return fail(reply, 429, "TRANSACTION_LIMIT_EXCEEDED", "Transaction storage is full");
      }
    }
    const queryId = randomUUID();
    transaction.queries.set(queryId, { queryId, query: sql, serializedParameters, bytes });
    queryTransactions.set(queryId, transaction.transactionId);
    transaction.bytes += bytes;
    storedBytes += bytes;
    transaction.expiresAt = Date.now() + retentionMs;
    return reply.code(201).send({ success: true, transactionId: transaction.transactionId, queryId });
  });

  const remove = async (request: FastifyRequest<{ Body: TransactionBody }>, reply: FastifyReply) => {
    const transaction = await requireTransaction(request, reply);
    if (!transaction) return;
    if (transaction.status !== "pending") {
      return fail(reply, 409, "TRANSACTION_NOT_PENDING", "Transaction is no longer pending");
    }
    const queryId = request.headers["query-id"] ?? request.headers["x-query-id"] ?? request.body?.queryId;
    if (typeof queryId !== "string" || !queryId) {
      return fail(reply, 400, "QUERY_ID_REQUIRED", "A query ID is required");
    }
    const query = transaction.queries.get(queryId);
    if (!query) {
      return fail(reply, 404, "QUERY_NOT_FOUND", "Query not found");
    }
    transaction.queries.delete(queryId);
    queryTransactions.delete(queryId);
    transaction.bytes -= query.bytes;
    storedBytes -= query.bytes;
    transaction.expiresAt = Date.now() + retentionMs;
    return { success: true, transactionId: transaction.transactionId, queryId };
  };
  fastify.post("/remove", remove);
  fastify.delete("/remove", remove);

  function describeQueued(transaction: Transaction) {
    return {
      success: true,
      transactionId: transaction.transactionId,
      database: transaction.database,
      status: transaction.status,
      queries: [...transaction.queries.values()].map(({ queryId, query, serializedParameters }) => ({
        queryId, query, parameters: JSON.parse(serializedParameters),
      })),
    };
  }

  async function getById(request: FastifyRequest, reply: FastifyReply, id: string) {
    const queued = findTransaction(request, id);
    if (queued) return describeQueued(queued);
    try {
      const record = await storedTransaction(request, id);
      if (!record) return fail(reply, 404, "TRANSACTION_NOT_FOUND", "Transaction not found");
      const { expired, input, outcome, completedQueries, ...metadata } = record;
      const finalized = ["committed", "rejected", "failed", "unknown"].includes(record.status);
      const abandoned = expired && !finalized;
      const status = abandoned ? (record.status === "committing" ? "unknown" : "failed") : record.status;
      const abandonedError = abandoned && {
        code: status === "unknown" ? "TRANSACTION_COMMIT_FAILED" : "TRANSACTION_INTERRUPTED",
        message: status === "unknown" ? "The commit could not be confirmed" : "The transaction did not finish",
      };
      return {
        success: true,
        ...metadata, ...input, status, finalized, database: request.database,
        progress: { completed: completedQueries, total: input.queries.length },
        ...(outcome && { outcome }),
        ...(abandonedError && { error: abandonedError }),
      };
    } catch (error) {
      request.log.error({ err: error }, "Could not read transaction status");
      return fail(reply, 503, "TRANSACTION_STORE_UNAVAILABLE", "Could not read transaction status");
    }
  }

  fastify.get<{ Params: { id: string } }>("/:id", (request, reply) => getById(request, reply, request.params.id));
  fastify.get<{ Querystring: { queryId?: string } }>("/", async (request, reply) => {
    const queryId = request.headers["query-id"] ?? request.headers["x-query-id"] ?? request.query?.queryId;
    if (queryId !== undefined) {
      const id = typeof queryId === "string" ? queryTransactions.get(queryId) : undefined;
      const transaction = id ? findTransaction(request, id) : undefined;
      return transaction ? describeQueued(transaction) : fail(reply, 404, "QUERY_NOT_FOUND", "Query not found");
    }
    const id = transactionHeader(request, reply);
    if (id) return getById(request, reply, id);
  });

  async function deleteById(request: FastifyRequest, reply: FastifyReply, id: string) {
    const queued = findTransaction(request, id);
    if (queued) {
      if (queued.status === "committing") {
        return fail(reply, 409, "TRANSACTION_COMMITTING", "Transaction is committing");
      }
      removeTransaction(queued);
    } else {
      try {
        const record = await storedTransaction(request, id);
        if (!record) return fail(reply, 404, "TRANSACTION_NOT_FOUND", "Transaction not found");
        if (!await store.remove(id, request.apiKey?.id ?? "", request.databaseOid)) {
          return fail(reply, 409, "TRANSACTION_IN_PROGRESS", "The execution record is still in use");
        }
      } catch (error) {
        request.log.error({ err: error }, "Could not delete transaction record");
        return fail(reply, 503, "TRANSACTION_STORE_UNAVAILABLE", "Could not delete transaction record");
      }
    }
    return { success: true, transactionId: id };
  }

  fastify.delete<{ Params: { id: string } }>("/:id", (request, reply) => deleteById(request, reply, request.params.id));
  fastify.delete("/", async (request, reply) => {
    const id = transactionHeader(request, reply);
    if (id) return deleteById(request, reply, id);
  });
};

export default transactionRoutes;
