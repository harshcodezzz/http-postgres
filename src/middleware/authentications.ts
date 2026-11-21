import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import {
  verifyApiKey,
  isValidDatabaseName,
} from "../utils/api-key.js";
import { verifyPassword, hashPassword } from "../utils/bootstrap.js";
import type { DataStore, JsonDB } from "../plugins/jsondb.js";

export { hashPassword, verifyPassword };

const maxConcurrentAdminVerifications = 2;
const maxQueuedAdminVerifications = 8;
let activeAdminVerifications = 0;
const adminVerificationWaiters: Array<(release: () => void) => void> = [];

function releaseAdminVerification() {
  const next = adminVerificationWaiters.shift();
  if (next) {
    next(releaseAdminVerification);
  } else {
    activeAdminVerifications--;
  }
}

function acquireAdminVerification(): Promise<(() => void) | undefined> {
  if (activeAdminVerifications < maxConcurrentAdminVerifications) {
    activeAdminVerifications++;
    return Promise.resolve(releaseAdminVerification);
  }
  if (adminVerificationWaiters.length >= maxQueuedAdminVerifications) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => adminVerificationWaiters.push(resolve));
}

export class AdminVerificationBusyError extends Error {
  constructor() {
    super("Admin password verification capacity is exhausted");
    this.name = "AdminVerificationBusyError";
  }
}

export async function verifyAdminPassword(
  adminPassword: string,
  jsondb: JsonDB,
): Promise<boolean> {
  const data = await jsondb.read<DataStore>();
  const storedHash = data.admin?.hash;
  if (!storedHash) return false;
  const release = await acquireAdminVerification();
  if (!release) throw new AdminVerificationBusyError();
  try {
    return await verifyPassword(adminPassword, storedHash);
  } finally {
    release();
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("apiKey", null);
  fastify.decorateRequest("admin", false);
  fastify.decorateRequest("database", "");
  fastify.decorateRequest("databaseOid", "");
  fastify.decorateRequest("queryAccess", null);

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.publicHealth) return;
    const urlPath = request.routeOptions.url ?? request.url.split("?")[0];

    const admin = request.headers["x-admin"];
    const isAdminRoute = urlPath === "/admin" || urlPath.startsWith("/admin/");

    if (isAdminRoute) {
      if (typeof admin === "string") {
        let matches: boolean;
        try {
          matches = await verifyAdminPassword(admin, fastify.jsondb);
        } catch (error) {
          if (!(error instanceof AdminVerificationBusyError)) throw error;
          reply.header("Retry-After", "1");
          return reply.code(503).send({
            success: false,
            error: {
              code: "ADMIN_AUTH_BUSY",
              message: "Admin authentication is temporarily busy",
            },
          });
        }

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

    const result = await verifyApiKey(database, apiKey, { db: fastify.jsondb, pgPool: fastify.db });

    if (!result.valid || !result.record || !result.databaseOid) {
      const rebindRequired = result.error === "DATABASE_SCOPE_UNBOUND";
      return reply.code(401).send({
        success: false,
        error: {
          code: rebindRequired ? "API_KEY_SCOPE_REBIND_REQUIRED" : "UNAUTHORIZED",
          message: rebindRequired ? "Ask an administrator to update this API key's database scope" : "error",
        },
      });
    }

    request.apiKey = result.record;
    request.database = database;
    request.databaseOid = result.databaseOid;
    request.queryAccess = result.access ?? null;
  });
};

export default fp(authPlugin, {
  name: "auth",
});
