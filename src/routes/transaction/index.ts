import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
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

  function requireTransaction(request: FastifyRequest, reply: FastifyReply) {
    const id = request.headers["transaction-id"] ?? request.headers["x-transaction-id"];
    if (typeof id !== "string" || !id) {
      fail(reply, 400, "TRANSACTION_ID_REQUIRED", "The transaction-id header is required");
      return;
    }
    const transaction = findTransaction(request, id);
    if (!transaction) fail(reply, 404, "TRANSACTION_NOT_FOUND", "Transaction not found");
    return transaction;
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
    reply: FastifyReply,
    immediate = false,
  ) {
    const execution = watchExecution(reply, 60_000);
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
      await execution.wait(client.query(beginStatement(transaction.options)));
      execution.check();
      // Establish the snapshot before user SQL can try to change isolation or enable writes.
      if (hasTransactionModes(transaction.options)) await execution.wait(client.query("SELECT 1"));
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
        const result = await execution.wait(resultBudget.query(client, statement)) as QueryResult;
        results.push({ ...(immediate ? { queryIndex: results.length } : { queryId }), ...formatQueryResult(result, transaction.options.fullResults) });
      }
      execution.check();
      queryId = undefined;
      commitSent = true;
      const result = await execution.wait(client.query("COMMIT"));
      if (result.command === "ROLLBACK") {
        transaction.status = "pending";
        return fail(reply, 400, "TRANSACTION_ROLLED_BACK", "PostgreSQL rolled back the transaction");
      }
      if (result.command !== "COMMIT") throw new Error("Unexpected PostgreSQL COMMIT result");
      transaction.status = "committed";
      return { success: true, ...(!immediate && { transactionId: transaction.transactionId }), results };
    } catch (error) {
      if (commitSent) {
        if (error instanceof PostgresError && error.severity === "ERROR" && error.code &&
          (error.code.startsWith("23") || error.code === "40001" || error.code === "40P01")) {
          transaction.status = "pending";
          return reply.code(400).send({
            success: false,
            error: {
              ...queryExecutionError(error).error,
              code: "TRANSACTION_ROLLED_BACK",
            },
          });
        }
        transaction.status = "failed";
        fastify.log.error({ err: error, transactionId: transaction.transactionId }, "Commit could not be confirmed");
        return fail(reply, 500, "TRANSACTION_COMMIT_FAILED", "The commit could not be confirmed");
      }
      if (client && !execution.stopped) {
        try {
          await execution.wait(client.query("ROLLBACK"));
        } catch (rollbackError) {
          fastify.log.error({ err: rollbackError }, "Failed to roll back transaction");
        }
      }
      transaction.status = "pending";
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return fail(reply, status, code, message);
      }
      if (!client) {
        const { status, code, message } = queryConnectionError(error);
        if (status === 503) fastify.log.error({ err: error }, "Failed to open transaction connection");
        return fail(reply, status, code, message);
      }
      if (queryId) {
        const result = queryExecutionError(error);
        return reply.code(result.status).send({ success: false, error: { ...result.error, ...(immediate ? { queryIndex: Number(queryId) } : { queryId }) } });
      }
      if (error instanceof PostgresError) {
        const result = queryExecutionError(error);
        return reply.code(error.code === "57014" ? 504 : 503).send({
          success: false, error: { ...result.error, code: "TRANSACTION_UNAVAILABLE" },
        });
      }
      fastify.log.error({ err: error }, "Failed to start transaction");
      return fail(reply, 503, "TRANSACTION_UNAVAILABLE", "Could not start the PostgreSQL transaction");
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
    const { queries, options } = request.body ?? {};
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
    return commit(transaction, request.queryScopes, reply, true);
  });

  fastify.post("/", create);
  fastify.post("/create", create);

  fastify.post<{ Body: TransactionBody | string }>("/add", async (request, reply) => {
    const transaction = requireTransaction(request, reply);
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
      return commit(transaction, request.queryScopes, reply);
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
    const transaction = requireTransaction(request, reply);
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

  fastify.get<{ Querystring: { queryId?: string } }>("/", async (request, reply) => {
    const queryId = request.headers["query-id"] ?? request.headers["x-query-id"] ?? request.query?.queryId;
    let transaction: Transaction | undefined;
    if (queryId !== undefined) {
      const id = typeof queryId === "string" ? queryTransactions.get(queryId) : undefined;
      transaction = id ? findTransaction(request, id) : undefined;
      if (!transaction) return fail(reply, 404, "QUERY_NOT_FOUND", "Query not found");
    } else {
      transaction = requireTransaction(request, reply);
      if (!transaction) return;
    }
    return {
      success: true,
      transactionId: transaction.transactionId,
      database: transaction.database,
      status: transaction.status,
      queries: [...transaction.queries.values()].map(({ queryId, query, serializedParameters }) => ({
        queryId, query, parameters: JSON.parse(serializedParameters),
      })),
    };
  });

  fastify.delete("/", async (request, reply) => {
    const transaction = requireTransaction(request, reply);
    if (!transaction) return;
    if (transaction.status === "committing") {
      return fail(reply, 409, "TRANSACTION_COMMITTING", "Transaction is committing");
    }
    removeTransaction(transaction);
    return { success: true, transactionId: transaction.transactionId };
  });
};

export default transactionRoutes;
