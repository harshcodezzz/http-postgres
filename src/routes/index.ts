import type { FastifyInstance } from "fastify";
import adminRoutes from "./admin/index.js";

export async function registerRoutes(app: FastifyInstance) {
  // Public health check route
  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Admin routes (protected by auth middleware)
  await app.register(adminRoutes, { prefix: "/admin" });
}
