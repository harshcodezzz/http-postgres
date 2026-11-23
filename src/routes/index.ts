import type { FastifyInstance } from "fastify";
import { createExecutionStore } from "./execution-store.js";
import config from "../config/index.js";
import { createQueryAnalytics } from "../utils/query-analytics.js";
import adminRoutes from "./admin/index.js";
import queryRoutes from "./query/index.js";
import transactionRoutes from "./transaction/index.js";
import { createQueryPools } from "../utils/query-pool.js";

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
  app.addHook("onClose", () => queryPools.close());

  const healthRoute = { config: { publicHealth: true } };
  const live = async () => ({ status: "ok" });
  app.get("/health", healthRoute, live);
  app.get("/health/live", healthRoute, live);

  type Readiness = {
    status: "ready" | "not_ready";
    checks: { postgres: "up" | "down"; redis: "up" | "down" | "disabled" };
  };
  let readiness: { expiresAt: number; result: Readiness } | undefined;
  let checking: Promise<Readiness> | undefined;
  let postgresChecking: Promise<unknown> | undefined;
  const checkReadiness = () => {
    if (readiness && readiness.expiresAt > Date.now()) return Promise.resolve(readiness.result);
    if (checking) return checking;
    checking = (async () => {
      postgresChecking ??= Promise.resolve(app.db.query("SELECT 1"))
        .finally(() => { postgresChecking = undefined; });
      const [postgres, redis] = await Promise.all([
        bounded(postgresChecking).then(() => true, () => false),
        config.redis.enabled
          ? bounded(app.redis.set("health:readiness", "1", 5)).then(() => true, () => false)
          : Promise.resolve(true),
      ]);
      const result: Readiness = {
        status: postgres && redis ? "ready" : "not_ready",
        checks: {
          postgres: postgres ? "up" : "down",
          redis: config.redis.enabled ? (redis ? "up" : "down") : "disabled",
        },
      };
      readiness = { expiresAt: Date.now() + readinessCacheMs, result };
      return result;
    })().finally(() => { checking = undefined; });
    return checking;
  };
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
