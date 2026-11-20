import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import config from "../config/index.js";

const rateLimitIp: FastifyPluginAsync = async (fastify) => {
  if (!config.ratelimit.enabled) {
    return;
  }

  const limit = config.ratelimit.requestPerMinutePerIp;
  const windowSeconds = 60;

  fastify.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;

    if (config.ratelimit.whitelistedIPs.includes(ip)) {
      return;
    }

    const key = `ratelimit:ip:${ip}`;
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

export default fp(rateLimitIp, {
  name: "ip-rate-limit",
  dependencies: ["redis"],
});
