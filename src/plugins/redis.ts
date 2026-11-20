import fp from "fastify-plugin";
import { Redis } from "ioredis";
import type { FastifyPluginAsync } from "fastify";
import config from "../config/index.js";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  increment(key: string, ttlSeconds?: number): Promise<number>;
  close(): Promise<void>;
}

class MemoryStore implements KeyValueStore {
  private store = new Map<
    string,
    {
      value: string;
      expiresAt: number | null;
    }
  >();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);

    if (!entry) return null;

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || (entry.expiresAt !== null && now >= entry.expiresAt)) {
      const initialValue = 1;
      this.store.set(key, {
        value: String(initialValue),
        expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : null,
      });
      return initialValue;
    }

    const nextValue = (parseInt(entry.value, 10) || 0) + 1;
    entry.value = String(nextValue);
    return nextValue;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

class RedisStore implements KeyValueStore {
  constructor(private readonly client: Redis) {}

  async get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, value, "EX", ttlSeconds);
      return;
    }

    await this.client.set(key, value);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async exists(key: string) {
    return (await this.client.exists(key)) > 0;
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const count = await this.client.incr(key);
    if (ttlSeconds !== undefined) {
      if (count === 1) {
        await this.client.expire(key, ttlSeconds);
      } else {
        const ttl = await this.client.ttl(key);
        if (ttl === -1) {
          await this.client.expire(key, ttlSeconds);
        }
      }
    }
    return count;
  }

  async close() {
    await this.client.quit();
  }
}

declare module "fastify" {
  interface FastifyInstance {
    redis: KeyValueStore;
  }
}

const redisPlugin: FastifyPluginAsync = async (app) => {
  if (!config.redis.enabled) {
    app.decorate("redis", new MemoryStore());
    app.log.info("Using in-memory store");
  } else {
    if (!config.redis.url) {
      throw new Error("Redis URL is required");
    }

    const client = new Redis(config.redis.url, {
      lazyConnect: true,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        return Math.min(times * 500, 5_000);
      },
    });

    client.on("error", (error) => {
      app.log.error({ err: error }, "Redis connection error");
    });

    try {
      await client.connect();
      await client.ping();
    } catch (error) {
      client.disconnect();
      throw new Error("Failed to connect to Redis", { cause: error });
    }

    app.decorate("redis", new RedisStore(client));
    app.log.info("Redis connected");
  }

  app.addHook("onClose", async () => {
    await app.redis.close();
    app.log.info("Store connection closed");
  });
};

export default fp(redisPlugin, {
  name: "redis",
});
