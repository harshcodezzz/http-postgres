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
  metrics(): { enabled: boolean; status: string; failures: number; timeouts: number; fallback: boolean };
}

class MemoryStore implements KeyValueStore {
  private store = new Map<
    string,
    {
      value: string;
      expiresAt: number | null;
    }
  >();
  private readonly cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) this.store.delete(key);
    }
  }, 60_000).unref();

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
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }

  metrics() { return { enabled: false, status: "up", failures: 0, timeouts: 0, fallback: true }; }
}

class RedisStore implements KeyValueStore {
  private failures = 0;
  private timeouts = 0;
  constructor(private readonly client: Redis) {}

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.failures++;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ETIMEDOUT" || (error instanceof Error && /timed?\s*out/i.test(error.message))) this.timeouts++;
      throw error;
    }
  }

  async get(key: string) {
    return this.run(() => this.client.get(key));
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds !== undefined) {
      await this.run(() => this.client.set(key, value, "EX", ttlSeconds));
      return;
    }

    await this.run(() => this.client.set(key, value));
  }

  async del(key: string) {
    await this.run(() => this.client.del(key));
  }

  async exists(key: string) {
    return (await this.run(() => this.client.exists(key))) > 0;
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    if (ttlSeconds === undefined) return this.run(() => this.client.incr(key));
    const count = await this.run(() => this.client.eval(`
      local count = redis.call("INCR", KEYS[1])
      if count == 1 or redis.call("TTL", KEYS[1]) == -1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return count
    `, 1, key, ttlSeconds));
    if (typeof count !== "number") throw new Error("Redis returned an invalid rate-limit count");
    return count;
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  metrics() {
    return {
      enabled: true,
      status: this.client.status === "ready" ? "up" : "down",
      failures: this.failures,
      timeouts: this.timeouts,
      fallback: false,
    };
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
