import type { FastifyInstance } from "fastify";
import adminRoutes from "./admin/index.js";
import queryRoutes from "./query/index.js";

export async function registerRoutes(app: FastifyInstance) {
  // Public health check route
  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Admin routes (protected by auth middleware)
  await app.register(adminRoutes, { prefix: "/admin" });

  // Query routes (protected by auth middleware: x-api-key & x-database)
  await app.register(queryRoutes, { prefix: "/query" });
}
