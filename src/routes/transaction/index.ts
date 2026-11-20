import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { DatabaseError as PostgresError, type PoolClient, type QueryConfig } from "pg";
import { queryConnectionError, queryExecutionError } from "../../utils/query-pool.js";
import { formatQueryResult } from "../query/index.js";

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
}

interface TransactionBody {
  query?: unknown;
  parameters?: unknown;
  params?: unknown;
  queryId?: unknown;
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

  function create(request: FastifyRequest, reply: FastifyReply) {
    if (!request.apiKey || !request.databaseOid) {
      return fail(reply, 401, "UNAUTHORIZED", "A database-scoped API key is required");
    }
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
    });
    storedBytes += transactionOverhead;
    return reply.code(201).send({ success: true, transactionId });
  }

  async function commit(
    transaction: Transaction,
    scopes: FastifyRequest["queryScopes"],
    reply: FastifyReply,
  ) {
    transaction.status = "committing";
    let client: PoolClient | undefined;
    let commitSent = false;
    let queryId: string | undefined;
    try {
      client = await fastify.queryPools.connect(transaction.database, transaction.databaseOid, scopes);
      await client.query("BEGIN");
      const results = [];
      for (const queued of transaction.queries.values()) {
        queryId = queued.queryId;
        // The extended protocol permits one SQL statement per queued query.
        const statement: QueryConfig & { queryMode: "extended" } = {
          text: queued.query,
          values: JSON.parse(queued.serializedParameters),
          queryMode: "extended",
        };
        const result = await client.query(statement);
        results.push({ queryId, ...formatQueryResult(result) });
      }
      queryId = undefined;
      commitSent = true;
      const result = await client.query("COMMIT");
      if (result.command === "ROLLBACK") {
        transaction.status = "pending";
        return fail(reply, 400, "TRANSACTION_ROLLED_BACK", "PostgreSQL rolled back the transaction");
      }
      if (result.command !== "COMMIT") throw new Error("Unexpected PostgreSQL COMMIT result");
      transaction.status = "committed";
      return { success: true, transactionId: transaction.transactionId, results };
    } catch (error) {
      if (commitSent) {
        if (error instanceof PostgresError && error.severity === "ERROR" && error.code &&
          (error.code.startsWith("23") || error.code === "40001" || error.code === "40P01")) {
          transaction.status = "pending";
          return reply.code(400).send({
            success: false,
            error: {
              code: "TRANSACTION_ROLLED_BACK",
              message: error.message,
              pgCode: error.code,
            },
          });
        }
        transaction.status = "failed";
        fastify.log.error({ err: error, transactionId: transaction.transactionId }, "Commit could not be confirmed");
        return fail(reply, 500, "TRANSACTION_COMMIT_FAILED", "The commit could not be confirmed");
      }
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          fastify.log.error({ err: rollbackError }, "Failed to roll back transaction");
        }
      }
      transaction.status = "pending";
      if (!client) {
        const { status, code, message } = queryConnectionError(error);
        if (status === 503) fastify.log.error({ err: error }, "Failed to open transaction connection");
        return fail(reply, status, code, message);
      }
      if (queryId) {
        const result = queryExecutionError(error);
        return reply.code(result.status).send({ success: false, error: { ...result.error, queryId } });
      }
      fastify.log.error({ err: error }, "Failed to start transaction");
      return fail(reply, 503, "TRANSACTION_UNAVAILABLE", "Could not start the PostgreSQL transaction");
    } finally {
      // Discard session-level changes made by queued SQL.
      client?.release(true);
      transaction.expiresAt = Date.now() + retentionMs;
    }
  }

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

    const command = /^[A-Za-z]+/.exec(sql.trim())?.[0].toUpperCase();
    if (!command || transactionCommands.has(command)) {
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
