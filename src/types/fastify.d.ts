import type { Pool } from "pg";
import type { JsonDB, ApiKeyRecord } from "../plugins/jsondb.js";
import type { KeyValueStore } from "../plugins/redis.js";
import type { QueryPools } from "../utils/query-pool.js";
import type { QueryAccess } from "../utils/query-access.js";
import type { OperationalMetrics } from "../services/operational-metrics.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    redis: KeyValueStore;
    jsondb: JsonDB;
    queryPools: QueryPools;
    metrics: OperationalMetrics;
  }

  interface FastifyRequest {
    apiKey: ApiKeyRecord | null;
    admin: boolean;
    database: string;
    databaseOid: string;
    queryAccess: QueryAccess | null;
    metricsStartedAt: number;
    metricsFinished: boolean;
  }

  interface FastifyContextConfig {
    publicHealth?: boolean;
  }
}
