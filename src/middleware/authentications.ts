import type { FastifyInstance } from "fastify";

export default async function auth(fastify: FastifyInstance) {
  fastify.addHook("onRequest", async (request, reply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "MISSING_API_KEY",
          message: "Authorization header is required",
        },
      });
    }

    const match = /^KEY_(LIVE|TEST)_([A-Za-z0-9_-]+)$/.exec(authHeader);

    if (!match) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "INVALID_API_KEY",
          message: "Invalid API key format",
        },
      });
    }

    const [, environment, secret] = match;

    // TODO:
    // 1. Hash secret.
    // 2. Find matching API key in JOSNDB.
    // 3. Verify active/revoked status.
    // 4. Attach authenticated key context to request.
  });
}
