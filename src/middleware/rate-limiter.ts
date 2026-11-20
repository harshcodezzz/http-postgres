import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import config from "../config/index.js";

const rateLimit: FastifyPluginAsync = async (fastify) => {
  if (!config.ratelimit.enabled) {
    return;
  }

  const limit = config.ratelimit.requestPerMinute;
  const windowSeconds = 60;

  fastify.addHook("onRequest", async (request, reply) => {
    // Only rate-limit authenticated requests — unauthenticated ones
    // are already rejected by the auth middleware before this runs.
    const apiKeyRecord = request.apiKey;
    if (!apiKeyRecord) {
      return;
    }

    const key = `ratelimit:key:${apiKeyRecord.keyHash}`;
    const requests = await fastify.redis.increment(key, windowSeconds);
    const remaining = Math.max(0, limit - requests);

    reply.header("X-RateLimit-Limit", limit);
    reply.header("X-RateLimit-Remaining", remaining);

    if (requests > limit) {
      reply.header("Retry-After", windowSeconds);

      return reply.code(429).send({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
        },
      });
    }
  });
};

export default fp(rateLimit, {
  name: "rate-limit",
  dependencies: ["redis", "auth"],
});
