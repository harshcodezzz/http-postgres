import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { BlockList, isIP } from "node:net";
import config from "../config/index.js";

const rateLimitIp: FastifyPluginAsync = async (fastify) => {
  if (!config.ratelimit.enabled) {
    return;
  }

  const limit = config.ratelimit.requestPerMinutePerIp;
  const windowSeconds = 60;
  const whitelist = new BlockList();
  for (const entry of config.ratelimit.whitelistedIPs) {
    const separator = entry.lastIndexOf("/");
    const address = separator < 0 ? entry : entry.slice(0, separator);
    const type = isIP(address) === 4 ? "ipv4" : "ipv6";
    if (separator < 0) whitelist.addAddress(address, type);
    else whitelist.addSubnet(address, Number(entry.slice(separator + 1)), type);
  }

  fastify.addHook("onRequest", async (request, reply) => {
    if (!config.ratelimit.enabled) {
      return;
    }

    if (request.routeOptions.config.publicHealth) return;
    const ip = request.ip;

    const version = isIP(ip);
    if (version && whitelist.check(ip, version === 4 ? "ipv4" : "ipv6")) {
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
