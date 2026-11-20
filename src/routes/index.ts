import type { FastifyInstance } from "fastify";
import adminRoutes from "./admin/index.js";
import queryRoutes from "./query/index.js";
import transactionRoutes from "./transaction/index.js";
import { createQueryPools } from "../utils/query-pool.js";

export async function registerRoutes(app: FastifyInstance) {
  const queryPools = createQueryPools(app.databaseAdminRoles, app.log);
  app.decorate("queryPools", queryPools);
  app.addHook("onClose", () => queryPools.close());

  // Public health check route
  app.get("/health", { config: { publicHealth: true } }, async () => {
    return { status: "ok" };
  });

  // Admin routes (protected by auth middleware)
  await app.register(adminRoutes, { prefix: "/admin" });

  // Query routes (protected by auth middleware: x-api-key & x-database)
  await app.register(queryRoutes, { prefix: "/query" });
  await app.register(transactionRoutes, { prefix: "/transaction" });
}
