import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { DatabaseError as PostgresError, type PoolClient, type QueryResult } from "pg";
import { isScopedStatement } from "../../utils/query-access.js";
import { queryConnectionError, queryExecutionError } from "../../utils/query-pool.js";
import type { ExecutionOutcome, ExecutionStore } from "../execution-store.js";
import { createResultBudget, ExecutionStopped, losslessTypes, watchExecution, type ResultStatement } from "./execution.js";
import { resultOptions, type ResultOptions } from "./options.js";

interface QueryBody {
  query?: string;
  parameters?: unknown[];
  params?: unknown[];
  options?: unknown;
  type?: unknown;
}

type QueryContext = Pick<FastifyRequest, "database" | "databaseOid" | "queryAccess" | "log"> & { owner: string };

const asyncStatementTimeout = 5 * 60_000;
const asyncExecutionDeadline = asyncStatementTimeout + 5_000;
const asyncRecordWindow = asyncExecutionDeadline + 30_000;
const maxAsyncQueries = 32;

export function formatQueryResult(result: QueryResult, fullResults?: boolean) {
  const rows = result.rows ?? [];
  if (fullResults === false) return { rows };
  return {
    command: result.command ?? "SELECT",
    rowCount: result.rowCount ?? rows.length,
    rows,
    fields: result.fields?.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
  };
}

function failure(status: number, code: string, message: string) {
  return { status, payload: { success: false, error: { code, message } } };
}

function unknownOutcome(cause: string) {
  return {
    status: 500,
    payload: {
      success: false,
      error: {
        code: "QUERY_OUTCOME_UNKNOWN",
        message: "The SQL may have taken effect. Verify its outcome before retrying.",
        cause,
      },
    },
  };
}

function send(reply: FastifyReply, { status, payload }: ExecutionOutcome) {
  return reply.code(status).send(payload);
}

const queryRoutes: FastifyPluginAsync<{ store: ExecutionStore }> = async (fastify, { store }) => {
  const activeQueries = new Set<Promise<void>>();
  fastify.addHook("onClose", async () => {
    await Promise.allSettled(activeQueries);
  });

  async function executeQuery(
    { database, databaseOid, queryAccess, owner, log }: QueryContext,
    statement: ResultStatement,
    options: ResultOptions,
    reply?: FastifyReply,
  ): Promise<ExecutionOutcome> {
    const start = Date.now();
    const execution = watchExecution(reply, reply ? 35_000 : asyncExecutionDeadline, fastify.queryPools);
    let client: PoolClient;
    try {
      execution.check();
      client = await execution.wait(fastify.queryPools.connect(
        database, databaseOid, queryAccess, owner, execution.signal, reply ? undefined : asyncStatementTimeout,
      ).then((connection) => {
        execution.attach(connection);
        return connection;
      }));
    } catch (err) {
      execution.close();
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return failure(status, code, message);
      }
      const { status, code, message } = queryConnectionError(err);
      if (code === "QUERY_DATABASE_UNAVAILABLE") log.error({ err, database }, "Could not open query connection");
      return failure(status, code, message);
    }

    let submitted = false;
    try {
      const result = await execution.run(() => {
        submitted = true;
        return createResultBudget(execution).query(client, statement);
      });
      const durationMs = Date.now() - start;
      if (Array.isArray(result)) {
        return {
          status: 200,
          payload: {
            success: true, database, durationMs,
            results: result.map((item) => formatQueryResult(item, options.fullResults)),
          },
        };
      }

      const data = formatQueryResult(result, options.fullResults);
      return { status: 200, payload: { success: true, database, ...data, durationMs, data } };
    } catch (err) {
      const interruption = execution.stopped ?? (err instanceof ExecutionStopped ? err : undefined);
      if (submitted && (interruption || !(err instanceof PostgresError) || err.severity !== "ERROR")) {
        return unknownOutcome(interruption?.code ?? "QUERY_RESULT_UNAVAILABLE");
      }
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return failure(status, code, message);
      }
      const { status, error } = queryExecutionError(err);
      return { status, payload: { success: false, error } };
    } finally {
      execution.close();
    }
  }

  const handleQuery = async (request: FastifyRequest<{ Body: QueryBody }>, reply: FastifyReply) => {
    const { apiKey, database, databaseOid, queryAccess, log } = request;
    if (!apiKey || !databaseOid) {
      return send(reply, failure(401, "UNAUTHORIZED", "A database-scoped API key is required"));
    }

    const body = request.body;
    if (typeof body?.query !== "string" || !body.query.trim()) {
      return send(reply, failure(400, "INVALID_QUERY", "Query string is required in 'query'"));
    }
    if (body.type !== undefined && body.type !== "sync" && body.type !== "async") {
      return send(reply, failure(400, "INVALID_QUERY_TYPE", "Use 'sync' or 'async' for 'type'"));
    }
    if (queryAccess && !isScopedStatement(body.query)) {
      return send(reply, failure(403, "INSUFFICIENT_PRIVILEGE", "Scoped API keys can run only data queries"));
    }

    const parameters = body.parameters !== undefined ? body.parameters : body.params;
    if (parameters !== undefined && !Array.isArray(parameters)) {
      return send(reply, failure(400, "INVALID_PARAMETERS", "Query parameters must be an array"));
    }
    const parsed = resultOptions.safeParse(body.options === undefined ? {} : body.options);
    if (!parsed.success) {
      return send(reply, failure(400, "INVALID_OPTIONS", "Result options must contain boolean flags"));
    }

    const options = parsed.data;
    const asyncQuery = body.type === "async";
    const context = { database, databaseOid, queryAccess, owner: apiKey.id, log };
    const statement: ResultStatement = {
      text: body.query,
      types: options.lossless === false ? undefined : losslessTypes,
      values: parameters ?? [],
      queryMode: queryAccess ? "extended" : undefined,
      rowMode: options.arrayMode ? "array" : undefined,
      query_timeout: asyncQuery ? asyncExecutionDeadline : undefined,
    };
    if (!asyncQuery) return send(reply, await executeQuery(context, statement, options, reply));
    if (activeQueries.size >= maxAsyncQueries) {
      return send(reply, failure(503, "QUERY_QUEUE_FULL", "Too many asynchronous queries are running"));
    }

    const queryId = randomUUID();
    const saved = store.createQuery(queryId, apiKey.id, databaseOid, asyncRecordWindow);
    const task = saved.then(async () => {
      const outcome = await executeQuery(context, statement, options).catch((err) => {
        log.error({ err, queryId }, "Asynchronous query execution could not be confirmed");
        return unknownOutcome("QUERY_RESULT_UNAVAILABLE");
      });
      await store.finishQuery(queryId, outcome);
    }, () => {}).catch((err) => {
      log.error({ err, queryId }, "Could not save asynchronous query outcome");
    }).finally(() => {
      activeQueries.delete(task);
    });
    activeQueries.add(task);

    try {
      await saved;
    } catch (err) {
      log.error({ err, queryId }, "Could not save asynchronous query");
      return send(reply, failure(503, "QUERY_STORE_UNAVAILABLE", "Could not save asynchronous query"));
    }
    return reply.header("Location", `/query/${queryId}`).code(202).send({
      success: true, queryId, status: "running",
    });
  };

  async function getQuery(request: FastifyRequest, reply: FastifyReply, queryId: unknown) {
    reply.header("Cache-Control", "no-store");
    if (typeof queryId !== "string" || !queryId) {
      return send(reply, failure(400, "QUERY_ID_REQUIRED", "A query ID is required"));
    }
    try {
      const { apiKey, database, databaseOid } = request;
      const record = await store.takeQuery(queryId, apiKey?.id ?? "", databaseOid);
      if (!record) return send(reply, failure(404, "QUERY_NOT_FOUND", "Query not found"));
      if (!record.finalized) return { success: true, queryId, database, status: "running", finalized: false };
      const outcome = record.outcome ?? unknownOutcome("QUERY_INTERRUPTED");
      const error = "error" in outcome.payload ? outcome.payload.error : undefined;
      const unknown = typeof error === "object" && error !== null && "code" in error && error.code === "QUERY_OUTCOME_UNKNOWN";
      const status = outcome.status === 200 ? "completed" : unknown ? "unknown" : "failed";
      return { success: true, queryId, database, status, finalized: true, outcome };
    } catch (err) {
      request.log.error({ err, queryId }, "Could not retrieve asynchronous query");
      return send(reply, failure(503, "QUERY_STORE_UNAVAILABLE", "Could not retrieve asynchronous query"));
    }
  }

  fastify.post("/", handleQuery);
  fastify.post("/run", handleQuery);
  fastify.get<{ Params: { id: string } }>("/:id", { exposeHeadRoute: false }, (request, reply) =>
    getQuery(request, reply, request.params.id));
  fastify.get<{ Querystring: { queryId?: string } }>("/", { exposeHeadRoute: false }, (request, reply) =>
    getQuery(request, reply, request.headers["query-id"] ?? request.headers["x-query-id"] ?? request.query?.queryId));
};

export default queryRoutes;
