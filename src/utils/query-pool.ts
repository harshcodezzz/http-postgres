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
  serverStartedAt: string;
  idle: boolean;
}

export function createQueryPools(adminDb: Pool, adminRoles: string[], log: FastifyBaseLogger) {
  const pools = new Map<string, Map<string, Pool>>();
  const maintenance = new Set<string>();
  const reservedClients = new WeakSet<PoolClient>();
  const backends = new WeakMap<PoolClient, BackendSession>();
  const closingBackends = new Map<BackendSession, number>();
  let closeCheck: NodeJS.Timeout | undefined;
  let monitoringFailure: {
    reason: "server_mismatch" | "observer_error";
    since: string;
    consecutiveFailures: number;
  } | null = null;
  let lastSuccessfulCheckAt: string | null = null;
  let rejectionsAtLimit = 0;
  let closed = false;

  function capacity() {
    const limit = config.database.pool.maxGlobalQueries;
    const oldest = closingBackends.values().next().value;
    return {
      limit,
      reserved: queryConnections,
      available: Math.max(0, limit - queryConnections),
      awaitingVerification: closingBackends.size,
      oldestUnverifiedMs: oldest === undefined ? null : Math.floor(performance.now() - oldest),
      rejectionsAtLimit,
      monitoring: {
        status: monitoringFailure ? "degraded" : closingBackends.size ? "checking" : "idle",
        failure: monitoringFailure,
        lastSuccessfulCheckAt,
      },
    };
  }

  function scheduleCloseCheck(waitMs: number) {
    if (closed || closeCheck || closingBackends.size === 0) return;
    closeCheck = setTimeout(async () => {
      let nextDelay = 100;
      let serverMismatch = false;
      try {
        const sessions = [...closingBackends.keys()];
        const { rows } = await adminDb.query<{
          serverStartedAt: string;
          pid: number | null;
          oid: string | null;
          startedAt: string | null;
          state: string | null;
          applicationName: string | null;
        }>(`
          SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text AS "serverStartedAt",
                 activity.pid, activity.datid::pg_catalog.text AS oid, activity.state,
                 EXTRACT(EPOCH FROM activity.backend_start)::pg_catalog.text AS "startedAt",
                 activity.application_name AS "applicationName"
          FROM (SELECT 1) AS server LEFT JOIN pg_catalog.pg_stat_activity AS activity
            ON activity.pid = ANY($1::pg_catalog.int4[])
        `, [sessions.map(({ pid }) => pid)]);
        if (closed) return;
        const observedServer = rows[0]?.serverStartedAt;
        if (!observedServer) throw new Error("PostgreSQL did not identify the monitoring server");
        const byPid = new Map(rows.map((row) => [row.pid, row]));
        for (const session of sessions) {
          if (session.serverStartedAt !== observedServer) {
            serverMismatch = true;
            continue;
          }
          const current = byPid.get(session.pid);
          const original = current?.oid === session.oid &&
            (current.startedAt === null || current.startedAt === session.startedAt);
          // A session-mode proxy may keep the backend after it resets the client session.
          const reset = current?.state === "idle" && current.applicationName !== session.applicationName;
          if ((!original || reset) && closingBackends.delete(session)) queryConnections--;
        }
        if (serverMismatch) throw new Error("PostgreSQL backend checks reached a different server");
        const recovered = monitoringFailure !== null;
        monitoringFailure = null;
        lastSuccessfulCheckAt = new Date().toISOString();
        if (recovered) log.info({ capacity: capacity() }, "Query backend monitoring recovered");
      } catch (err) {
        if (closed) return;
        const reason = serverMismatch ? "server_mismatch" : "observer_error";
        const changed = monitoringFailure?.reason !== reason;
        monitoringFailure = {
          reason,
          since: monitoringFailure?.since ?? new Date().toISOString(),
          consecutiveFailures: (monitoringFailure?.consecutiveFailures ?? 0) + 1,
        };
        if (changed) log.warn({ err, capacity: capacity() }, "Could not verify that closed query backends finished");
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
      rejectionsAtLimit++;
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
        if (session && !closed && !session.idle) {
          closingBackends.set(session, performance.now());
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
      const { rows: [identity] } = await client.query<Omit<BackendSession, "idle">>(`
        SELECT pid, datid::pg_catalog.text AS oid,
               EXTRACT(EPOCH FROM backend_start)::pg_catalog.text AS "startedAt",
               EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text AS "serverStartedAt",
               pg_catalog.set_config('application_name', $1, false) AS "applicationName",
               pg_catalog.set_config('statement_timeout', $2, false)
        FROM pg_catalog.pg_stat_activity
        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
      `, [`http-postgres-${randomUUID()}`, String(statementTimeoutMillis)]);
      if (!identity || identity.oid !== oid) {
        throw new DatabaseError("Could not identify the query backend", "QUERY_DATABASE_UNAVAILABLE");
      }
      // Database OIDs are local to a cluster. Confirm this live session from the admin connection.
      const { rows: [observer] } = await adminDb.query<{ verified: boolean }>(`
        SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text = $4 AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE pid = $1 AND datid = $2::pg_catalog.oid AND application_name = $3
        ) AS verified
      `, [identity.pid, identity.oid, identity.applicationName, identity.serverStartedAt]);
      if (!observer?.verified) {
        throw new DatabaseError("The query backend is not on the administrative PostgreSQL server", "QUERY_DATABASE_UNAVAILABLE");
      }
      const session = { ...identity, idle: client.getTransactionStatus() === "I" };
      // ReadyForQuery includes the backend's transaction status after each execution cycle.
      client.connection.on("readyForQuery", () => { session.idle = client.getTransactionStatus() === "I"; });
      backends.set(client, session);
      checkMaintenance();
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  function queryDispatched(client: PoolClient) {
    const session = backends.get(client);
    if (session) session.idle = false;
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

  return { connect, queryDispatched, withMaintenance, capacity, close };
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
