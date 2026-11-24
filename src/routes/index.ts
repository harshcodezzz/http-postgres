import type { FastifyInstance } from "fastify";
import { createExecutionStore } from "./execution-store.js";
import config from "../config/index.js";
import { createQueryAnalytics } from "../utils/query-analytics.js";
import adminRoutes from "./admin/index.js";
import queryRoutes from "./query/index.js";
import transactionRoutes from "./transaction/index.js";
import { createQueryPools } from "../utils/query-pool.js";
import type { ReadinessResult } from "../types/fastify.js";

const readinessTimeoutMs = 2_000;
const readinessCacheMs = 1_000;

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Dependency check timed out")), readinessTimeoutMs).unref();
    void operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function registerRoutes(app: FastifyInstance) {
  const executionStore = createExecutionStore(app.db);
  const analytics = config.analytics.enabled
    ? createQueryAnalytics(config.analytics.directory, app.log, config.analytics)
    : undefined;
  if (analytics) app.addHook("onClose", () => analytics.close());
  const queryPools = createQueryPools(app.db, app.databaseAdminRoles, app.log);
  app.decorate("queryPools", queryPools);
  app.addHook("onReady", async () => { await queryPools.warm(); });
  app.addHook("onReady", async () => { app.metrics.setReady(true); });
  app.addHook("onClose", () => queryPools.close());

  const healthRoute = { config: { publicHealth: true } };
  const live = async () => ({ status: "ok" });
  app.get("/health", healthRoute, live);
  app.get("/health/live", healthRoute, live);

  let shuttingDown = false;
  let readiness: { expiresAt: number; result: ReadinessResult } | undefined;
  let checking: Promise<ReadinessResult> | undefined;
  let postgresChecking: Promise<unknown> | undefined;
  let redisChecking: Promise<unknown> | undefined;
  const checkReadiness = () => {
    if (shuttingDown) return Promise.resolve<ReadinessResult>({
      status: "not_ready",
      checks: { postgres: "up", redis: config.redis.enabled ? "up" : "disabled", metadata: "up", queryMonitoring: "up" },
      latencyMs: { postgres: 0, redis: 0, metadata: 0 },
    });
    if (readiness && readiness.expiresAt > Date.now()) return Promise.resolve(readiness.result);
    if (checking) return checking;
    checking = (async () => {
      postgresChecking ??= Promise.resolve(app.db.query("SELECT 1"))
        .finally(() => { postgresChecking = undefined; });
      if (config.redis.enabled) {
        redisChecking ??= app.redis.set("health:readiness", "1", 5)
          .finally(() => { redisChecking = undefined; });
      }
      const check = async (operation: Promise<unknown>) => {
        const startedAt = performance.now();
        const healthy = await bounded(operation).then(() => true, () => false);
        return { healthy, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
      };
      const [postgresResult, redisResult, metadataResult] = await Promise.all([
        check(postgresChecking),
        config.redis.enabled
          ? check(redisChecking ?? Promise.reject(new Error("Redis check unavailable")))
          : Promise.resolve({ healthy: true, latencyMs: 0 }),
        check(app.jsondb.metrics()),
      ]);
      const postgres = postgresResult.healthy;
      const redis = redisResult.healthy;
      const metadata = metadataResult.healthy;
      const queryMonitoring = app.queryPools.capacity().monitoring.status !== "degraded";
      const healthy = !shuttingDown && postgres && redis && metadata && queryMonitoring;
      const result: ReadinessResult = {
        status: healthy ? "ready" : "not_ready",
        checks: {
          postgres: postgres ? "up" : "down",
          redis: config.redis.enabled ? (redis ? "up" : "down") : "disabled",
          metadata: metadata ? "up" : "down",
          queryMonitoring: queryMonitoring ? "up" : "down",
        },
        latencyMs: {
          postgres: postgresResult.latencyMs,
          redis: redisResult.latencyMs,
          metadata: metadataResult.latencyMs,
        },
      };
      readiness = { expiresAt: Date.now() + readinessCacheMs, result };
      app.metrics.setReady(healthy);
      return result;
    })().finally(() => { checking = undefined; });
    return checking;
  };
  app.decorate("checkReadiness", checkReadiness);
  app.decorate("beginShutdown", () => {
    shuttingDown = true;
    readiness = undefined;
    app.metrics.setReady(false);
  });
  app.addHook("preClose", () => app.beginShutdown());
  app.get("/health/ready", healthRoute, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const result = await checkReadiness();
    if (result.status !== "ready") reply.code(503);
    return result;
  });

  // Admin routes (protected by auth middleware)
  await app.register(adminRoutes, { prefix: "/admin", analytics });

  // Query routes (protected by auth middleware: x-api-key & x-database)
  await app.register(queryRoutes, { prefix: "/query", store: executionStore, analytics });
  await app.register(transactionRoutes, { prefix: "/transaction", store: executionStore, analytics });
}
