import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyById,
  listApiKeys,
  updateApiKeyScope,
  ApiKeyError,
  type ApiKeyEnvironment,
} from "../../utils/api-key.js";

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
    Body: {
      databases?: string[];
      database?: string;
      environment?: ApiKeyEnvironment;
    };
  }>("/keys", async (request, reply) => {
    const { databases, database, environment = "LIVE" } = request.body ?? {};

    const targetDbs = databases ?? (database ? [database] : []);
    if (!Array.isArray(targetDbs) || targetDbs.length === 0) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_DATABASE_NAME",
          message: "At least one database is required in 'databases' or 'database'",
        },
      });
    }

    try {
      const result = await createApiKey({
        databases: targetDbs,
        environment,
        db: fastify.jsondb,
        pgPool: fastify.db,
      });

      return reply.code(201).send({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      if (err instanceof ApiKeyError) {
        return reply.code(400).send({
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
    request: FastifyRequest<{ Params: { id: string }; Body: { databases?: string[] } }>,
    reply: FastifyReply,
  ) => {
    const { databases } = request.body ?? {};

    if (!Array.isArray(databases) || databases.length === 0) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_DATABASE_NAME",
          message: "At least one database is required in 'databases'",
        },
      });
    }

    try {
      const updated = await updateApiKeyScope(request.params.id, {
        databases,
        db: fastify.jsondb,
        pgPool: fastify.db,
      });

      return {
        success: true,
        key: updated,
      };
    } catch (err: unknown) {
      if (err instanceof ApiKeyError) {
        const statusCode = err.code === "KEY_NOT_FOUND" ? 404 : 400;
        return reply.code(statusCode).send({
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

  fastify.patch<{ Params: { id: string }; Body: { databases?: string[] } }>(
    "/keys/:id",
    updateScopeHandler,
  );
  fastify.put<{ Params: { id: string }; Body: { databases?: string[] } }>(
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
