import type { Pool } from "pg";
import type { JsonDB, ApiKeyRecord } from "../plugins/jsondb.js";
import type { KeyValueStore } from "../plugins/redis.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    redis: KeyValueStore;
    jsondb: JsonDB;
  }

  interface FastifyRequest {
    apiKey: ApiKeyRecord | null;
    admin: boolean;
    database: string;
  }
}
