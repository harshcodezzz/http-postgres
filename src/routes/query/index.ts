import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import config from "../../config/index.js";
import { getDatabasePool } from "../../utils/pg-database.js";

interface QueryBody {
  query?: string;
  parameters?: unknown[];
  params?: unknown[];
}

const poolsByDatabase = new Map<string, Pool>();

export function getQueryPool(
  databaseName: string,
  fastifyDb?: Pool,
): { query: (text: string, values?: any[]) => Promise<any> } {
  if (fastifyDb && !(fastifyDb instanceof Pool)) {
    return fastifyDb;
  }

  if (config?.database?.url) {
    try {
      const parsed = new URL(config.database.url);
      const defaultDb = parsed.pathname.replace(/^\//, "");
      if (defaultDb === databaseName && fastifyDb) {
        return fastifyDb;
      }
    } catch {
      if (fastifyDb) return fastifyDb;
    }
  }

  if (!poolsByDatabase.has(databaseName)) {
    try {
      const parsed = new URL(config.database.url);
      parsed.pathname = `/${databaseName}`;
      const pool = new Pool({
        connectionString: parsed.toString(),
        min: config.database?.pool?.min ?? 1,
        max: config.database?.pool?.max ?? 10,
        idleTimeoutMillis: 30_000,
      });
      pool.on("error", (err) => {
        console.error(`Unexpected error on pool for database '${databaseName}':`, err);
      });
      poolsByDatabase.set(databaseName, pool);
    } catch {
      if (fastifyDb) return fastifyDb;
      return getDatabasePool();
    }
  }

  return poolsByDatabase.get(databaseName) ?? fastifyDb ?? getDatabasePool();
}

export async function evictQueryPool(databaseName: string): Promise<void> {
  const pool = poolsByDatabase.get(databaseName);
  if (pool) {
    poolsByDatabase.delete(databaseName);
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}

export async function closeQueryPools(): Promise<void> {
  for (const pool of poolsByDatabase.values()) {
    await pool.end();
  }
  poolsByDatabase.clear();
}

const queryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onClose", async () => {
    await closeQueryPools();
  });

  const handleQuery = async (
    request: FastifyRequest<{ Body: QueryBody }>,
    reply: FastifyReply,
  ) => {
    const database =
      request.database ||
      (request.headers["x-database"] as string) ||
      (request.headers["x-db-name"] as string);

    if (!database) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "DATABASE_REQUIRED",
          message: "Database header 'x-database' is required",
        },
      });
    }

    const body = (request.body && typeof request.body === "object" ? request.body : {}) as QueryBody;
    const { query } = body;

    if (typeof query !== "string" || query.trim().length === 0) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_QUERY",
          message: "Query string is required in 'query'",
        },
      });
    }

    const rawParams = body.parameters !== undefined ? body.parameters : body.params;
    if (rawParams !== undefined && !Array.isArray(rawParams)) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_PARAMETERS",
          message: "Query parameters must be an array",
        },
      });
    }

    const parameters = Array.isArray(rawParams) ? rawParams : [];

    try {
      const pool = getQueryPool(database, fastify.db);
      const start = Date.now();
      const result = await pool.query(query, parameters);
      const durationMs = Date.now() - start;

      const rows = result.rows ?? [];
      const rowCount = result.rowCount ?? rows.length;
      const command = result.command ?? "SELECT";
      const fields = result.fields?.map((f: any) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      }));

      return {
        success: true,
        database,
        command,
        rowCount,
        rows,
        fields,
        durationMs,
        data: {
          command,
          rowCount,
          rows,
          fields,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const pgCode = typeof (err as any)?.code === "string" ? (err as any).code : undefined;

      return reply.code(400).send({
        success: false,
        error: {
          code: "QUERY_EXECUTION_ERROR",
          message,
          pgCode,
        },
      });
    }
  };

  fastify.post("/", handleQuery);
  fastify.post("/run", handleQuery);
};

export default queryRoutes;
