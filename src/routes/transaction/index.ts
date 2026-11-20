import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient, QueryConfig } from "pg";
import { formatQueryResult, getQueryPool, isDatabaseUnderMaintenance } from "../query/index.js";

interface QueuedQuery {
  queryId: string;
  query: string;
  parameters: unknown[];
}

interface Transaction {
  transactionId: string;
  database: string;
  owner: string;
  status: "pending" | "committing" | "committed" | "failed";
  queries: Map<string, QueuedQuery>;
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

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ success: false, error: { code, message } });
}

const transactionRoutes: FastifyPluginAsync = async (fastify) => {
  const transactions = new Map<string, Transaction>();
  const queryTransactions = new Map<string, string>();

  function findTransaction(request: FastifyRequest, id: string) {
    const transaction = transactions.get(id);
    if (transaction?.owner === request.apiKey?.id && transaction?.database === request.database) {
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
    if (!request.apiKey || !request.database) {
      return fail(reply, 401, "UNAUTHORIZED", "A database-scoped API key is required");
    }
    const transactionId = randomUUID();
    transactions.set(transactionId, {
      transactionId,
      database: request.database,
      owner: request.apiKey.id,
      status: "pending",
      queries: new Map(),
    });
    return reply.code(201).send({ success: true, transactionId });
  }

  async function commit(transaction: Transaction, reply: FastifyReply) {
    if (isDatabaseUnderMaintenance(transaction.database)) {
      return fail(reply, 409, "DATABASE_IN_USE", "Database maintenance is in progress");
    }
    transaction.status = "committing";
    let client: PoolClient | undefined;
    let commitSent = false;
    let queryId: string | undefined;
    try {
      client = await getQueryPool(transaction.database, fastify.db).connect();
      // A standalone query can leave a pooled connection inside a SQL transaction.
      await client.query("ROLLBACK");
      const { rows } = await client.query<{ database: string }>(
        "SELECT pg_catalog.current_database() AS database",
      );
      if (rows[0]?.database !== transaction.database) {
        throw new Error("PostgreSQL connected to a different database");
      }
      await client.query("BEGIN");
      const results = [];
      for (const queued of transaction.queries.values()) {
        queryId = queued.queryId;
        // The extended protocol permits one SQL statement per queued query.
        const statement: QueryConfig & { queryMode: "extended" } = {
          text: queued.query,
          values: queued.parameters,
          queryMode: "extended",
        };
        const result = await client.query(statement);
        results.push({ queryId, ...formatQueryResult(result) });
      }
      queryId = undefined;
      commitSent = true;
      const result = await client.query("COMMIT");
      if (result.command !== "COMMIT") {
        transaction.status = "pending";
        return fail(reply, 400, "TRANSACTION_ROLLED_BACK", "PostgreSQL rolled back the transaction");
      }
      transaction.status = "committed";
      return { success: true, transactionId: transaction.transactionId, results };
    } catch (error) {
      if (commitSent) {
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
      if (queryId) {
        return reply.code(400).send({
          success: false,
          error: {
            code: "QUERY_EXECUTION_ERROR",
            message: error instanceof Error ? error.message : "Query failed",
            queryId,
          },
        });
      }
      fastify.log.error({ err: error }, "Failed to start transaction");
      return fail(reply, 503, "TRANSACTION_UNAVAILABLE", "Could not start the PostgreSQL transaction");
    } finally {
      // Discard session-level changes made by queued SQL.
      client?.release(true);
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
      return commit(transaction, reply);
    }

    const command = /^[A-Za-z]+/.exec(sql.trim())?.[0].toUpperCase();
    if (!command || transactionCommands.has(command)) {
      return fail(reply, 400, "INVALID_QUERY", "Start with a SQL command other than transaction control");
    }
    const queryId = randomUUID();
    transaction.queries.set(queryId, { queryId, query: sql, parameters: parameters ?? [] });
    queryTransactions.set(queryId, transaction.transactionId);
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
    if (!transaction.queries.delete(queryId)) {
      return fail(reply, 404, "QUERY_NOT_FOUND", "Query not found");
    }
    queryTransactions.delete(queryId);
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
      queries: [...transaction.queries.values()],
    };
  });

  fastify.delete("/", async (request, reply) => {
    const transaction = requireTransaction(request, reply);
    if (!transaction) return;
    if (transaction.status === "committing") {
      return fail(reply, 409, "TRANSACTION_COMMITTING", "Transaction is committing");
    }
    for (const queryId of transaction.queries.keys()) queryTransactions.delete(queryId);
    transactions.delete(transaction.transactionId);
    return { success: true, transactionId: transaction.transactionId };
  });
};

export default transactionRoutes;
