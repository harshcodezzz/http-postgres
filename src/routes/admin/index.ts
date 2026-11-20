import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import adminApiRoutes from "./admin-api.js";
import adminDatabaseRoutes from "./admin-database.js";

const AUDIT_LOG_FILE = resolve(process.cwd(), "logs", "api-keys.log");
const GATEWAY_LOG_FILE = resolve(process.cwd(), "logs", "gateway.log");

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

  const isHealthy = postgresHealthy && redisHealthy && jsondbHealthy;

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
    },
  };
}

async function readRecentLogs(type: "audit" | "system", limit: number) {
  const logPath = type === "system" ? GATEWAY_LOG_FILE : AUDIT_LOG_FILE;

  try {
    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const recentLines = lines.slice(-limit);

    return recentLines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", async () => {
    return {
      success: true,
      service: "http-postgres-admin",
    };
  });

  await fastify.register(adminApiRoutes);
  await fastify.register(adminDatabaseRoutes);

  fastify.get("/health", async () => checkHealth(fastify));

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
