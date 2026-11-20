import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import {
  verifyApiKey,
  isValidDatabaseName,
  type ApiKeyRecord,
} from "../utils/api-key.js";
import { verifyPassword, hashPassword } from "../utils/bootstrap.js";
import type { DataStore, JsonDB } from "../plugins/jsondb.js";

export { hashPassword, verifyPassword };

export async function verifyAdminPassword(
  adminPassword: string,
  jsondb: JsonDB,
): Promise<boolean> {
  const data = await jsondb.read<DataStore>();
  const storedHash = data.admin?.hash;
  if (!storedHash) return false;
  return verifyPassword(adminPassword, storedHash);
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyRecord | null;
    admin: boolean;
    database: string;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("apiKey", null);
  fastify.decorateRequest("admin", false);
  fastify.decorateRequest("database", "");

  fastify.addHook("onRequest", async (request, reply) => {
    const urlPath = request.url.split("?")[0];
    if (urlPath === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return;
    }

    const admin = request.headers["x-admin"];
    const isAdminRoute = urlPath === "/admin" || urlPath.startsWith("/admin/");

    if (isAdminRoute) {
      if (typeof admin === "string") {
        const matches = await verifyAdminPassword(admin, fastify.jsondb);

        if (matches) {
          request.admin = true;
          return;
        }
      }

      return reply.code(401).send({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "error",
        },
      });
    }

    const apiKey =
      request.headers["x-api-key"] ?? request.headers.authorization;
    const database =
      request.headers["x-database"] ?? request.headers["x-db-name"];

    if (typeof apiKey !== "string" || !apiKey) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "error",
        },
      });
    }

    if (typeof database !== "string" || !database) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "DATABASE_REQUIRED",
          message: "error",
        },
      });
    }

    if (!isValidDatabaseName(database)) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_DATABASE",
          message: "error",
        },
      });
    }

    const result = await verifyApiKey(database, apiKey, fastify.jsondb);

    if (!result.valid || !result.record) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "error",
        },
      });
    }

    request.apiKey = result.record;
    request.database = database;
  });
};

export default fp(authPlugin, {
  name: "auth",
});
