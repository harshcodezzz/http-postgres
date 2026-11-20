import { Pool, type PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import config, { findQueryProfile } from "../config/index.js";
import { scopeKey, type QueryPrivilege } from "../config/query-privileges.js";
import { DatabaseError } from "./pg-database.js";

const connectionTimeoutMillis = 5_000;
const statementTimeoutMillis = 30_000;
const queryTimeoutMillis = 35_000;
let queryConnections = 0;

export function createQueryPools(adminRoles: string[], log: FastifyBaseLogger) {
  const pools = new Map<string, Map<string, Pool>>();
  const maintenance = new Set<string>();
  const reservedClients = new WeakSet<PoolClient>();

  async function evict(database: string) {
    const databasePools = pools.get(database);
    if (databasePools) {
      pools.delete(database);
      await Promise.all([...databasePools.values()].map((pool) => pool.end()));
    }
  }

  async function withMaintenance<T>(database: string, operation: () => Promise<T>, force = false) {
    if (maintenance.has(database)) {
      throw new DatabaseError("Database maintenance is already in progress", "DATABASE_IN_USE");
    }
    maintenance.add(database);
    try {
      if (!force) await evict(database);
      return await operation();
    } finally {
      try {
        if (force) await evict(database);
      } finally {
        maintenance.delete(database);
      }
    }
  }

  async function connect(
    database: string,
    oid: string,
    scopes: readonly QueryPrivilege[] | null = null,
  ): Promise<PoolClient> {
    function checkMaintenance() {
      if (maintenance.has(database)) {
        throw new DatabaseError("Database maintenance is in progress", "DATABASE_IN_USE");
      }
    }
    checkMaintenance();

    const profile = scopes ? findQueryProfile(database, scopes) : undefined;
    const defaultUrl = Object.hasOwn(config.database.queryUrls, database)
      ? config.database.queryUrls[database]
      : undefined;
    const connectionString = scopes ? profile?.url : defaultUrl;
    if (!connectionString) {
      throw new DatabaseError("Query credentials are unavailable for this database", "QUERY_DATABASE_UNAVAILABLE");
    }
    if (queryConnections >= config.database.pool.maxGlobalQueries) {
      throw new DatabaseError("The gateway query connection budget is exhausted", "QUERY_CONNECTION_LIMIT");
    }
    let databasePools = pools.get(database);
    if (!databasePools) {
      databasePools = new Map();
      pools.set(database, databasePools);
    }
    const poolKey = scopes ? scopeKey(scopes) : "";
    let pool = databasePools.get(poolKey);
    if (!pool) {
      pool = new Pool({
        connectionString,
        max: config.database.pool.max,
        connectionTimeoutMillis,
        query_timeout: queryTimeoutMillis,
      });
      pool.on("error", (err) => log.error({ err, database }, "Query connection pool error"));
      pool.on("remove", (client: PoolClient) => {
        if (reservedClients.delete(client)) queryConnections--;
      });
      databasePools.set(poolKey, pool);
    }

    queryConnections++;
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      queryConnections--;
      throw error;
    }
    reservedClients.add(client);
    client.on("error", (err) => log.warn({ err, database }, "Checked-out query connection error"));
    try {
      checkMaintenance();
      const excludedRoles = scopes
        ? adminRoles.concat(config.database.queryProfiles[database]
            .filter((candidate) => candidate.scopes.some((scope) => !scopes.includes(scope)))
            .map((candidate) => candidate.role))
        : adminRoles;
      const { rows: [target] } = await client.query<{
        name: string;
        oid: string;
        login: string;
        safe: boolean;
      }>(`
        SELECT d.datname AS name, d.oid::pg_catalog.text AS oid, session_user AS login,
          session_user OPERATOR(pg_catalog.=) current_user
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles r
            WHERE (r.rolname OPERATOR(pg_catalog.=) ANY($1::pg_catalog.name[])
              OR pg_catalog.left(r.rolname, 3) OPERATOR(pg_catalog.=) 'pg_'
              OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
              AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_database other
            WHERE other.oid OPERATOR(pg_catalog.<>) d.oid AND other.datallowconn
              AND pg_catalog.has_database_privilege(session_user, other.oid, 'CONNECT')
          ) AS safe
        FROM pg_catalog.pg_database d
        WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
      `, [excludedRoles]);
      checkMaintenance();
      if (target?.name !== database || !target.safe || (profile && target.login !== profile.role)) {
        throw new DatabaseError("Query credentials are unavailable for this database", "QUERY_DATABASE_UNAVAILABLE");
      }
      if (target.oid !== oid) {
        throw new DatabaseError("The API key scope no longer matches this database", "DATABASE_SCOPE_CHANGED");
      }
      await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, false)", [String(statementTimeoutMillis)]);
      checkMaintenance();
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async function close() {
    await Promise.all([...pools.keys()].map(evict));
  }

  return { connect, withMaintenance, close };
}

export type QueryPools = ReturnType<typeof createQueryPools>;

export function queryConnectionError(error: unknown) {
  if (error instanceof DatabaseError) {
    const status = error.code === "DATABASE_IN_USE" ? 409 :
      error.code === "DATABASE_SCOPE_CHANGED" ? 403 : 503;
    return { status, code: error.code, message: error.message };
  }
  return {
    status: 503,
    code: "QUERY_DATABASE_UNAVAILABLE",
    message: "Could not open a PostgreSQL query connection",
  };
}

export function queryExecutionError(error: unknown) {
  const pgCode = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const forbidden = pgCode === "42501";
  return {
    status: forbidden ? 403 : 400,
    error: {
      code: forbidden ? "INSUFFICIENT_PRIVILEGE" : "QUERY_EXECUTION_ERROR",
      message: error instanceof Error ? error.message : "Query failed",
      pgCode,
    },
  };
}
