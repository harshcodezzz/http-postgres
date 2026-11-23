import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { resolve } from "node:path";
import adminApiRoutes from "./admin-api.js";
import adminDatabaseRoutes from "./admin-database.js";
import { clearLogFiles, readAuditTail, readLogTail } from "../../utils/log-files.js";
import type { QueryAnalytics } from "../../utils/query-analytics.js";

const LOGS_DIRECTORY = resolve(process.cwd(), "logs");
const AUDIT_LOG_FILE = resolve(LOGS_DIRECTORY, "api-keys.log");
const GATEWAY_LOG_FILE = resolve(LOGS_DIRECTORY, "current.log");

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
  fastify.metrics.setReady(isHealthy);

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

  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const [metadata, gateway] = await Promise.all([
      fastify.jsondb.metrics(),
      Promise.resolve(fastify.metrics.snapshot()),
    ]);
    const query = fastify.queryPools.capacity();
    gateway.requests.overloadRejected += query.rejectionsAtLimit + query.rejectionsAtPoolLimit;
    const adminConnections = {
      total: fastify.db.totalCount,
      active: Math.max(0, fastify.db.totalCount - fastify.db.idleCount),
      idle: fastify.db.idleCount,
      waitingForAcquisition: fastify.db.waitingCount,
    };
    return {
      success: true,
      gateway,
      postgres: {
        scope: "gateway_managed_only",
        managedPools: query.managedPools + 1,
        administrativePool: adminConnections,
        queryPools: query,
        globalConnectionUsage: query.reserved,
        globalConnectionCapacity: query.limit,
        availableConcurrencySlots: query.available,
        connectionAcquisitionTimeouts: query.checkoutTimeouts,
        queryExecutionTimeouts: query.executionTimeouts,
        transactionFailures: gateway.transactionFailures,
        overloadRejections: query.rejectionsAtLimit + query.rejectionsAtPoolLimit,
        poolEvictions: query.evictions,
      },
      metadata: { ...metadata, cleanupWorker: gateway.cleanupWorker },
      analytics: analytics?.metrics() ?? { enabled: false, queueSize: 0, droppedEvents: 0 },
      redis: fastify.redis.metrics(),
    };
  });

  fastify.get<{ Querystring: { limit?: string } }>("/analytics", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!analytics) return { success: true, enabled: false };
    const limit = Math.min(Math.max(parseInt(request.query?.limit ?? "", 10) || 50, 1), 200);
    try {
      return { success: true, enabled: true, ...await analytics.report(limit) };
    } catch (error) {
      request.log.error({ err: error }, "Could not read query analytics");
      return reply.code(503).send({
        success: false,
        error: { code: "ANALYTICS_UNAVAILABLE", message: "Could not read query analytics" },
      });
    }
  });

  fastify.delete("/analytics", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!analytics) return { success: true, enabled: false };
    try {
      await analytics.clear();
      return {
        success: true,
        message: "Query analytics cleared successfully",
      };
    } catch (error) {
      request.log.error({ err: error }, "Could not clear query analytics");
      return reply.code(503).send({
        success: false,
        error: { code: "ANALYTICS_UNAVAILABLE", message: "Could not clear query analytics" },
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

  fastify.delete<{
    Querystring: { type?: "all" | "audit" | "system"; analytics?: string | boolean };
  }>("/logs", async (request, reply) => {
    const rawType = request.query?.type;
    const type = rawType === "audit" || rawType === "system" ? rawType : "all";
    const includeAnalytics = request.query?.analytics === true || request.query?.analytics === "true";

    try {
      const clearedFiles = await clearLogFiles(LOGS_DIRECTORY, type);
      let analyticsCleared = false;
      if (includeAnalytics && analytics) {
        try {
          await analytics.clear();
          analyticsCleared = true;
        } catch (error) {
          request.log.warn({ err: error }, "Could not clear analytics during log deletion");
        }
      }

      return {
        success: true,
        message: "Logs deleted successfully",
        type,
        clearedFiles,
        ...(includeAnalytics && { analyticsCleared }),
      };
    } catch (error) {
      request.log.error({ err: error }, "Could not delete logs");
      return reply.code(500).send({
        success: false,
        error: { code: "LOG_DELETION_FAILED", message: "Could not delete logs" },
      });
    }
  });
};

export default adminRoutes;
