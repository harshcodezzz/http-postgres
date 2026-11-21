import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { resolve } from "node:path";
import adminApiRoutes from "./admin-api.js";
import adminDatabaseRoutes from "./admin-database.js";
import { readAuditTail, readLogTail } from "../../utils/log-files.js";
import type { QueryAnalytics } from "../../utils/query-analytics.js";

const AUDIT_LOG_FILE = resolve(process.cwd(), "logs", "api-keys.log");
const GATEWAY_LOG_FILE = resolve(process.cwd(), "logs", "current.log");

async function checkHealth(fastify: FastifyInstance) {
  let postgresHealthy = false;
  let postgresLatency = 0;
  try {
    const start = Date.now();
    await fastify.db.query("SELECT 1");
    postgresLatency = Date.now() - start;
    postgresHealthy = true;
  } catch {
    postgresHealthy = false;
  }

  let redisHealthy = false;
  let redisLatency = 0;
  try {
    const start = Date.now();
    await fastify.redis.set("health:check", "1", 5);
    redisLatency = Date.now() - start;
    redisHealthy = true;
  } catch {
    redisHealthy = false;
  }

  let jsondbHealthy = false;
  try {
    await fastify.jsondb.read();
    jsondbHealthy = true;
  } catch {
    jsondbHealthy = false;
  }

  const queryConnections = fastify.queryPools.capacity();
  const isHealthy = postgresHealthy && redisHealthy && jsondbHealthy &&
    queryConnections.monitoring.status !== "degraded";

  return {
    success: true,
    status: isHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    services: {
      postgres: {
        status: postgresHealthy ? "up" : "down",
        latencyMs: postgresLatency,
      },
      redis: {
        status: redisHealthy ? "up" : "down",
        latencyMs: redisLatency,
      },
      jsondb: {
        status: jsondbHealthy ? "up" : "down",
      },
      queryConnections,
    },
  };
}

async function readRecentLogs(type: "audit" | "system", limit: number) {
  if (type === "system") return readLogTail(GATEWAY_LOG_FILE, limit);
  return readAuditTail(AUDIT_LOG_FILE, limit);
}

const adminRoutes: FastifyPluginAsync<{ analytics?: QueryAnalytics }> = async (fastify, { analytics }) => {
  fastify.get("/", async () => {
    return {
      success: true,
      service: "http-postgres-admin",
    };
  });

  await fastify.register(adminApiRoutes);
  await fastify.register(adminDatabaseRoutes);

  fastify.get("/health", async () => checkHealth(fastify));

  fastify.get<{ Querystring: { limit?: string } }>("/analytics", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!analytics) return { success: true, enabled: false };
    const limit = Math.min(Math.max(parseInt(request.query?.limit ?? "", 10) || 50, 1), 200);
    try {
      return { success: true, enabled: true, ...analytics.report(limit) };
    } catch (error) {
      request.log.error({ err: error }, "Could not read query analytics");
      return reply.code(503).send({
        success: false,
        error: { code: "ANALYTICS_UNAVAILABLE", message: "Could not read query analytics" },
      });
    }
  });

  fastify.get<{
    Querystring: { type?: "audit" | "system"; limit?: string };
  }>("/logs", async (request) => {
    const type = request.query?.type === "system" ? "system" : "audit";
    const limit = Math.min(
      Math.max(parseInt(request.query?.limit ?? "100", 10) || 100, 1),
      500,
    );

    const logs = await readRecentLogs(type, limit);
    return {
      success: true,
      type,
      count: logs.length,
      logs,
    };
  });
};

export default adminRoutes;
