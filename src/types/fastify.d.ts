import type { Pool } from "pg";
import type { JsonDB, ApiKeyRecord } from "../plugins/jsondb.js";
import type { KeyValueStore } from "../plugins/redis.js";
import type { QueryPools } from "../utils/query-pool.js";
import type { QueryPrivilege } from "../config/query-privileges.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    redis: KeyValueStore;
    jsondb: JsonDB;
    queryPools: QueryPools;
  }

  interface FastifyRequest {
    apiKey: ApiKeyRecord | null;
    admin: boolean;
    database: string;
    databaseOid: string;
    queryScopes: QueryPrivilege[] | null;
  }

  interface FastifyContextConfig {
    publicHealth?: boolean;
  }
}
