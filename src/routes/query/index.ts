import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { DatabaseError as PostgresError, type PoolClient, type QueryResult } from "pg";
import { queryConnectionError, queryExecutionError } from "../../utils/query-pool.js";

import { createResultBudget, ExecutionStopped, losslessTypes, watchExecution, type ResultStatement } from "./execution.js";
import { resultOptions } from "./options.js";

interface QueryBody {
  query?: string;
  parameters?: unknown[];
  params?: unknown[];
  options?: unknown;
}

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

const queryRoutes: FastifyPluginAsync = async (fastify) => {
  const handleQuery = async (
    request: FastifyRequest<{ Body: QueryBody }>,
    reply: FastifyReply,
  ) => {
    const { database, databaseOid, queryScopes } = request;
    if (!databaseOid) {
      return reply.code(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "A database-scoped API key is required" },
      });
    }

    const body = request.body;
    if (typeof body?.query !== "string" || !body.query.trim()) {
      return reply.code(400).send({
        success: false,
        error: { code: "INVALID_QUERY", message: "Query string is required in 'query'" },
      });
    }

    const parameters = body.parameters !== undefined ? body.parameters : body.params;
    if (parameters !== undefined && !Array.isArray(parameters)) {
      return reply.code(400).send({
        success: false,
        error: { code: "INVALID_PARAMETERS", message: "Query parameters must be an array" },
      });
    }

    const parsed = resultOptions.safeParse(body.options === undefined ? {} : body.options);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: { code: "INVALID_OPTIONS", message: "Result options must contain boolean flags" } });
    }
    const options = parsed.data;
    const start = Date.now();
    const execution = watchExecution(reply, 35_000, fastify.queryPools.queryDispatched);
    let client: PoolClient;
    try {
      client = await execution.wait(fastify.queryPools.connect(database, databaseOid, queryScopes).then((connection) => {
        execution.attach(connection);
        return connection;
      }));
    } catch (err) {
      execution.close();
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return reply.code(status).send({ success: false, error: { code, message } });
      }
      const { status, code, message } = queryConnectionError(err);
      if (status === 503) request.log.error({ err, database }, "Could not open query connection");
      return reply.code(status).send({ success: false, error: { code, message } });
    }

    let submitted = false;
    try {
      const statement: ResultStatement = {
        text: body.query,
        types: options.lossless === false ? undefined : losslessTypes,
        values: parameters ?? [],
        rowMode: options.arrayMode ? "array" : undefined,
      };
      const result: QueryResult | QueryResult[] = await execution.run(() => {
        submitted = true;
        return createResultBudget(execution).query(client, statement);
      });
      const durationMs = Date.now() - start;
      if (Array.isArray(result)) {
        return {
          success: true,
          database,
          durationMs,
          results: result.map((statement) => formatQueryResult(statement, options.fullResults)),
        };
      }

      const data = formatQueryResult(result, options.fullResults);
      return { success: true, database, ...data, durationMs, data };
    } catch (err) {
      const interruption = execution.stopped ?? (err instanceof ExecutionStopped ? err : undefined);
      if (submitted && (interruption || !(err instanceof PostgresError) || err.severity !== "ERROR")) {
        const cause = interruption?.code ?? "QUERY_RESULT_UNAVAILABLE";
        return reply.code(500).send({
          success: false,
          error: {
            code: "QUERY_OUTCOME_UNKNOWN",
            message: "The SQL may have taken effect. Verify its outcome before retrying.",
            cause,
          },
        });
      }
      if (execution.stopped) {
        const { status, code, message } = execution.stopped;
        return reply.code(status).send({ success: false, error: { code, message } });
      }
      const { status, error } = queryExecutionError(err);
      return reply.code(status).send({ success: false, error });
    } finally {
      execution.close();
    }
  };

  fastify.post("/", handleQuery);
  fastify.post("/run", handleQuery);
};

export default queryRoutes;
