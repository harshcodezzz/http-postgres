import type { FastifyInstance } from "fastify";
import config from "../config/index.js";
import { createHash } from "node:crypto";

export default async function rateLimit(fastify: FastifyInstance) {
  const limit = config.ratelimit.requestPerMinute;
  const windowSeconds = 60;

  fastify.addHook("onRequest", async (request, reply) => {
    if (!config.ratelimit.enabled) {
      return;
    }

    const apiKey = request.headers["x-api-key"];

    if (typeof apiKey !== "string" || !apiKey) {
      return;
    }

    const keyHash = createHash("sha256").update(apiKey).digest("hex");

    const key = `ratelimit:${keyHash}`;

    const requests = await fastify.redis.increment(key, windowSeconds);

    reply.header("X-RateLimit-Limit", limit);
    reply.header("X-RateLimit-Remaining", Math.max(0, limit - requests));

    if (requests > limit) {
      return reply.code(429).send({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
        },
      });
    }
  });
}
