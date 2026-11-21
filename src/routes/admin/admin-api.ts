import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyById,
  listApiKeys,
  updateApiKeyScope,
  ApiKeyError,
  type ApiKeyEnvironment,
  type ApiKeyScopeInput,
} from "../../utils/api-key.js";
import { DatabaseError } from "../../utils/pg-database.js";

function scopeErrorStatus(error: ApiKeyError | DatabaseError): number {
  switch (error.code) {
    case "KEY_NOT_FOUND":
    case "TABLE_NOT_FOUND":
    case "DATABASE_NOT_FOUND":
      return 404;
    case "INSUFFICIENT_PRIVILEGE":
      return 403;
    case "UNSAFE_DATABASE_SCOPE":
    case "DATABASE_SCOPE_CHANGED":
      return 409;
    default:
      return 400;
  }
}

const adminApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/keys", async () => {
    const keys = await listApiKeys(fastify.jsondb);
    return {
      success: true,
      count: keys.length,
      keys,
    };
  });

  fastify.get<{ Params: { id: string } }>("/keys/:id", async (request, reply) => {
    const key = await getApiKeyById(request.params.id, fastify.jsondb);
    if (!key) {
      return reply.code(404).send({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: `API key with ID '${request.params.id}' not found`,
        },
      });
    }

    return {
      success: true,
      key,
    };
  });

  fastify.post<{
    Body: ApiKeyScopeInput & { environment?: ApiKeyEnvironment };
  }>("/keys", async (request, reply) => {
    const { databases, database, tables, "scope-database": databaseScope, "scope-table": tableScope,
      environment = "LIVE" } = request.body ?? {};

    try {
      const result = await createApiKey({
        databases,
        database,
        tables,
        "scope-database": databaseScope,
        "scope-table": tableScope,
        environment,
        db: fastify.jsondb,
        pgPool: fastify.db,
      });

      return reply.code(201).send({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      if (err instanceof ApiKeyError || err instanceof DatabaseError) {
        return reply.code(scopeErrorStatus(err)).send({
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
        });
      }
      throw err;
    }
  });

  const updateScopeHandler = async (
    request: FastifyRequest<{ Params: { id: string }; Body: ApiKeyScopeInput }>,
    reply: FastifyReply,
  ) => {
    const { databases, database, tables, "scope-database": databaseScope, "scope-table": tableScope } = request.body ?? {};

    try {
      const updated = await updateApiKeyScope(request.params.id, {
        databases,
        database,
        tables,
        "scope-database": databaseScope,
        "scope-table": tableScope,
        db: fastify.jsondb,
        pgPool: fastify.db,
      });

      return {
        success: true,
        key: updated,
      };
    } catch (err: unknown) {
      if (err instanceof ApiKeyError || err instanceof DatabaseError) {
        return reply.code(scopeErrorStatus(err)).send({
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
        });
      }
      throw err;
    }
  };

  fastify.patch<{ Params: { id: string }; Body: ApiKeyScopeInput }>(
    "/keys/:id",
    updateScopeHandler,
  );
  fastify.put<{ Params: { id: string }; Body: ApiKeyScopeInput }>(
    "/keys/:id",
    updateScopeHandler,
  );

  fastify.delete<{
    Params: { id: string };
    Querystring: { hard?: string };
  }>("/keys/:id", async (request, reply) => {
    const isHard = request.query?.hard === "true";

    const success = await deleteApiKey(request.params.id, fastify.jsondb, {
      hardDelete: isHard,
    });

    if (!success) {
      return reply.code(404).send({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: `API key with ID '${request.params.id}' not found`,
        },
      });
    }

    return {
      success: true,
      message: isHard ? "API key permanently deleted" : "API key revoked",
    };
  });
};

export default adminApiRoutes;
