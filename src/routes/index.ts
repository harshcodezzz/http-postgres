import type { FastifyInstance } from "fastify";
import { createExecutionStore } from "./execution-store.js";
import config from "../config/index.js";
import { createQueryAnalytics } from "../utils/query-analytics.js";
import adminRoutes from "./admin/index.js";
import queryRoutes from "./query/index.js";
import transactionRoutes from "./transaction/index.js";
import { createQueryPools } from "../utils/query-pool.js";

export async function registerRoutes(app: FastifyInstance) {
  const executionStore = createExecutionStore(app.db);
  const analytics = config.analytics.enabled ? createQueryAnalytics(config.analytics.directory, app.log) : undefined;
  if (analytics) app.addHook("onClose", () => analytics.close());
  const queryPools = createQueryPools(app.db, app.databaseAdminRoles, app.log);
  app.decorate("queryPools", queryPools);
  app.addHook("onReady", async () => { await queryPools.warm(); });
  app.addHook("onClose", () => queryPools.close());

  // Public health check route
  app.get("/health", { config: { publicHealth: true } }, async () => {
    return { status: "ok" };
  });

  // Admin routes (protected by auth middleware)
  await app.register(adminRoutes, { prefix: "/admin", analytics });

  // Query routes (protected by auth middleware: x-api-key & x-database)
  await app.register(queryRoutes, { prefix: "/query", store: executionStore, analytics });
  await app.register(transactionRoutes, { prefix: "/transaction", store: executionStore, analytics });
}
