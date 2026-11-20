import { randomUUID } from "node:crypto";
import { DatabaseError as PostgresError, Pool, type PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import config, { findQueryProfile } from "../config/index.js";
import { scopeKey, type QueryPrivilege } from "../config/query-privileges.js";
import { DatabaseError } from "./pg-database.js";

const connectionTimeoutMillis = 5_000;
const statementTimeoutMillis = 30_000;
const queryTimeoutMillis = 35_000;
let queryConnections = 0;

interface BackendSession {
  pid: number;
  oid: string;
  startedAt: string | null;
  applicationName: string;
}

export function createQueryPools(adminDb: Pool, adminRoles: string[], log: FastifyBaseLogger) {
  const pools = new Map<string, Map<string, Pool>>();
  const maintenance = new Set<string>();
  const reservedClients = new WeakSet<PoolClient>();
  const backends = new WeakMap<PoolClient, BackendSession>();
  const closingBackends = new Set<BackendSession>();
  let closeCheck: NodeJS.Timeout | undefined;
  let closed = false;

  function scheduleCloseCheck(waitMs: number) {
    if (closed || closeCheck || closingBackends.size === 0) return;
    closeCheck = setTimeout(async () => {
      let nextDelay = 100;
      try {
        const sessions = [...closingBackends];
        const { rows } = await adminDb.query<BackendSession & { state: string | null }>(`
          SELECT pid, datid::pg_catalog.text AS oid, state,
                 EXTRACT(EPOCH FROM backend_start)::pg_catalog.text AS "startedAt",
                 application_name AS "applicationName"
          FROM pg_catalog.pg_stat_activity
          WHERE pid = ANY($1::pg_catalog.int4[])
        `, [sessions.map(({ pid }) => pid)]);
        if (closed) return;
        const byPid = new Map(rows.map((row) => [row.pid, row]));
        for (const session of sessions) {
          const current = byPid.get(session.pid);
          const original = current?.oid === session.oid &&
            (current.startedAt === null || current.startedAt === session.startedAt);
          // A session-mode proxy may keep the backend after it resets the client session.
          const reset = current?.state === "idle" && current.applicationName !== session.applicationName;
          if ((!original || reset) && closingBackends.delete(session)) queryConnections--;
        }
      } catch (err) {
        if (!closed) log.warn({ err }, "Could not verify that closed query backends finished");
        nextDelay = 1_000;
      } finally {
        closeCheck = undefined;
        scheduleCloseCheck(nextDelay);
      }
    }, waitMs).unref();
  }

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
        if (!reservedClients.delete(client)) return;
        const session = backends.get(client);
        // pg only sets readyForQuery after the backend finishes the execution cycle.
        const ready = (client as PoolClient & { readyForQuery?: boolean }).readyForQuery === true;
        if (session && !closed && (!ready || client.getTransactionStatus() !== "I")) {
          closingBackends.add(session);
          scheduleCloseCheck(0);
        } else {
          queryConnections--;
        }
      });
      databasePools.set(poolKey, pool);
    }

    if (pool.totalCount >= config.database.pool.max && pool.idleCount === 0) {
      throw new DatabaseError("The database query pool is busy", "QUERY_POOL_BUSY");
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
      const { rows: [session] } = await client.query<BackendSession>(`
        SELECT pid, datid::pg_catalog.text AS oid,
               EXTRACT(EPOCH FROM backend_start)::pg_catalog.text AS "startedAt",
               pg_catalog.set_config('application_name', $1, false) AS "applicationName",
               pg_catalog.set_config('statement_timeout', $2, false)
        FROM pg_catalog.pg_stat_activity
        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
      `, [`http-postgres-${randomUUID()}`, String(statementTimeoutMillis)]);
      if (!session || session.oid !== oid) {
        throw new DatabaseError("Could not identify the query backend", "QUERY_DATABASE_UNAVAILABLE");
      }
      // Database OIDs are local to a cluster. Confirm this live session from the admin connection.
      const { rows: [identity] } = await adminDb.query<{ verified: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE pid = $1 AND datid = $2::pg_catalog.oid AND application_name = $3
        ) AS verified
      `, [session.pid, session.oid, session.applicationName]);
      if (!identity?.verified) {
        throw new DatabaseError("The query backend is not on the administrative PostgreSQL server", "QUERY_DATABASE_UNAVAILABLE");
      }
      backends.set(client, session);
      checkMaintenance();
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async function close() {
    try {
      await Promise.all([...pools.keys()].map(evict));
    } finally {
      closed = true;
      clearTimeout(closeCheck);
      queryConnections -= closingBackends.size;
      closingBackends.clear();
    }
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
      ...(error instanceof PostgresError && {
        severity: error.severity ?? null,
        detail: config.database.exposeErrorDetails ? error.detail ?? null : null,
        hint: config.database.exposeErrorDetails ? error.hint ?? null : null,
        schema: error.schema ?? null,
        table: error.table ?? null,
        column: error.column ?? null,
        constraint: error.constraint ?? null,
        dataType: error.dataType ?? null,
        position: error.position ?? null,
      }),
    },
  };
}
