import fp from "fastify-plugin";
import { Pool } from "pg";
import type { FastifyPluginAsync } from "fastify";
import config from "../config/index.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    databaseAdminRoles: string[];
  }
}

const databasePlugin: FastifyPluginAsync = async (app) => {
  const pool = new Pool({
    connectionString: config.database.url,
    min: config.database.pool.min,
    max: config.database.pool.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  });

  pool.on("error", (error) => {
    const sanitized = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...("code" in error && typeof error.code === "string" && { code: error.code }),
      ...("severity" in error && { severity: (error as { severity?: unknown }).severity }),
      ...("detail" in error && { detail: (error as { detail?: unknown }).detail }),
      ...("hint" in error && { hint: (error as { hint?: unknown }).hint }),
    } : { message: String(error) };
    app.log.error({ err: sanitized }, "Unexpected PostgreSQL pool error");
  });

  try {
    const { rows: [roles] } = await pool.query<{ login: string; active: string }>(
      "SELECT session_user AS login, current_user AS active",
    );
    app.decorate("databaseAdminRoles", [...new Set([roles.login, roles.active])]);
  } catch (error) {
    await pool.end();

    throw new Error("Failed to connect to PostgreSQL", { cause: error });
  }

  app.decorate("db", pool);

  app.addHook("onClose", async () => {
    await pool.end();
    app.log.info("PostgreSQL connection pool closed");
  });

  app.log.info("PostgreSQL connected");
};

export default fp(databasePlugin, {
  name: "database",
});
