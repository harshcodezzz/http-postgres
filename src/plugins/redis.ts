import fp from "fastify-plugin";
import { Redis } from "ioredis";
import type { FastifyPluginAsync } from "fastify";
import config from "../config/index.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis | null;
  }
}

const redisPlugin: FastifyPluginAsync = async (app) => {
  if (!config.redis.enabled) {
    app.decorate("redis", null);
    app.log.info("Redis is disabled");
    return;
  }

  if (!config.redis.url) {
    throw new Error("Redis is enabled but no Redis URL was configured");
  }

  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,

    retryStrategy(times) {
      return Math.min(times * 500, 5_000);
    },
  });

  redis.on("error", (error) => {
    app.log.error({ err: error }, "Redis connection error");
  });

  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect();

    throw new Error("Failed to connect to Redis", { cause: error });
  }

  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    try {
      await redis.quit();
      app.log.info("Redis connection closed");
    } catch (error) {
      app.log.error(
        { err: error },
        "Failed to close Redis connection gracefully",
      );

      redis.disconnect();
    }
  });

  app.log.info("Redis connected");
};

export default fp(redisPlugin, {
  name: "redis",
});
