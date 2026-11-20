import { randomUUID } from "node:crypto";
import { Client, DatabaseError as PostgresError, Pool, type PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import config, { findQueryProfile } from "../config/index.js";
import { scopeKey, type QueryPrivilege } from "../config/query-privileges.js";
import { DatabaseError, getPostgresDatabaseOid } from "./pg-database.js";

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
  ownerId?: string;
}

export function createQueryPools(adminDb: Pool, adminRoles: string[], log: FastifyBaseLogger) {
  const pools = new Map<string, Map<string, Pool>>();
  const maintenance = new Set<string>();
  const reservedClients = new WeakSet<Client>();
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
  let rejectionsAtPoolLimit = 0;
  let warmTimer: NodeJS.Timeout | undefined;
  let warming: Promise<void> | undefined;
  let closing = false;
  let closed = false;

  function connectionLimit() {
    rejectionsAtLimit++;
    return new DatabaseError("The gateway query connection budget is exhausted", "QUERY_CONNECTION_LIMIT");
  }

  // pg-pool calls connect only when it opens a physical connection. Returning an
  // existing connection to a borrower does not take another global slot.
  class BudgetedClient extends Client {
    override connect(): Promise<Client>;
    override connect(callback: Parameters<Client["connect"]>[0]): void;
    override connect(callback?: Parameters<Client["connect"]>[0]): Promise<Client> | void {
      const operation = this.open();
      if (!callback) return operation;
      void operation.then(
        (client) => (callback as (error: null, client: Client) => void)(null, client),
        (error: Error) => (callback as (error: Error) => void)(error),
      );
    }

    private async open() {
      if (queryConnections >= config.database.pool.maxGlobalQueries) throw connectionLimit();
      queryConnections++;
      try {
        const client = await super.connect();
        reservedClients.add(client);
        return client;
      } catch (error) {
        queryConnections--;
        throw error;
      }
    }
  }

  function capacity() {
    const limit = config.database.pool.maxGlobalQueries;
    const oldest = closingBackends.values().next().value;
    return {
      limit,
      reserved: queryConnections,
      available: Math.max(0, limit - queryConnections),
      idle: [...pools.values()].flatMap((group) => [...group.values()])
        .reduce((count, pool) => count + pool.idleCount, 0),
      awaitingVerification: closingBackends.size,
      oldestUnverifiedMs: oldest === undefined ? null : Math.floor(performance.now() - oldest),
      rejectionsAtLimit,
      rejectionsAtPoolLimit,
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

  function removeClient(pool: Pool, client: PoolClient) {
    return new Promise<void>((resolve) => {
      const removed = (ended: PoolClient) => {
        if (ended !== client) return;
        pool.removeListener("remove", removed);
        resolve();
      };
      pool.on("remove", removed);
      client.release(true);
    });
  }

  async function reclaimIdleConnection(requested: Pool) {
    for (const group of pools.values()) {
      for (const pool of group.values()) {
        if (pool === requested || pool.idleCount <= pool.waitingCount) continue;
        const client = await pool.connect().catch(() => undefined);
        if (client) {
          await removeClient(pool, client);
          return true;
        }
      }
    }
    return false;
  }

  async function checkout(pool: Pool, ownerId: string | undefined) {
    const { max, maxGlobalQueries } = config.database.pool;
    for (let attempt = 0; attempt <= max; attempt++) {
      const hasIdle = pool.idleCount > pool.waitingCount;
      if (!hasIdle && pool.totalCount >= max) break;
      if (!hasIdle && queryConnections >= maxGlobalQueries) {
        if (ownerId === undefined || !await reclaimIdleConnection(pool)) throw connectionLimit();
      }
      const client = await pool.connect();
      const priorOwner = backends.get(client)?.ownerId;
      if (!priorOwner || ownerId === undefined || priorOwner === ownerId) return client;
      // PostgreSQL extensions can hold backend-local state beyond DISCARD ALL.
      // A connection used by one API key only returns to that same key.
      await removeClient(pool, client);
    }
    rejectionsAtPoolLimit++;
    throw new DatabaseError("The database query pool is busy", "QUERY_POOL_BUSY");
  }

  async function observeServer(session: Omit<BackendSession, "idle">, opening: boolean) {
    const { rows: [observer] } = await adminDb.query<{ verified: boolean }>(`
      SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text = $4 AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datid = $2::pg_catalog.oid
          AND ($3::pg_catalog.text IS NULL OR application_name = $3)
          AND (backend_start IS NULL OR EXTRACT(EPOCH FROM backend_start)::pg_catalog.text = $5)
      ) AS verified
    `, [session.pid, session.oid, opening ? session.applicationName : null, session.serverStartedAt, session.startedAt]);
    if (!observer?.verified) {
      throw new DatabaseError("The query backend is not on the administrative PostgreSQL server", "QUERY_DATABASE_UNAVAILABLE");
    }
  }

  async function connect(
    database: string,
    oid: string,
    scopes: readonly QueryPrivilege[] | null = null,
    ownerId?: string,
  ): Promise<PoolClient> {
    function checkMaintenance() {
      if (closing || maintenance.has(database)) {
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
        Client: BudgetedClient,
        pipeline: false,
        max: config.database.pool.max,
        min: config.database.pool.queryMin,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
        connectionTimeoutMillis,
        query_timeout: queryTimeoutMillis,
      });
      const checkedOutError = (err: Error) => log.warn({ err, database }, "Checked-out query connection error");
      pool.on("acquire", (client: PoolClient) => client.on("error", checkedOutError));
      pool.on("release", (_err: Error | undefined, client: PoolClient) => client.removeListener("error", checkedOutError));
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

    const client = await checkout(pool, ownerId);
    try {
      checkMaintenance();
      const excludedRoles = scopes
        ? adminRoles.concat(config.database.queryProfiles[database]
            .filter((candidate) => candidate.scopes.some((scope) => !scopes.includes(scope)))
            .map((candidate) => candidate.role))
        : adminRoles;
      const previous = backends.get(client);
      const sessionName = previous?.applicationName ?? `http-postgres-${randomUUID()}`;
      queryDispatched(client);
      const [{ rows: [target] }] = await Promise.all([client.query<Omit<BackendSession, "idle"> & {
        name: string;
        login: string;
        safe: boolean;
      }>(`
        SELECT d.datname AS name, d.oid::pg_catalog.text AS oid, session_user AS login,
          session_user OPERATOR(pg_catalog.=) current_user
          AND d.datallowconn
          AND pg_catalog.has_database_privilege(session_user, d.oid, 'CONNECT')
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
          ) AS safe,
          activity.pid,
          EXTRACT(EPOCH FROM activity.backend_start)::pg_catalog.text AS "startedAt",
          EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text AS "serverStartedAt",
          pg_catalog.set_config('application_name', $2, false) AS "applicationName",
          pg_catalog.set_config('statement_timeout', $3, false)
        FROM pg_catalog.pg_database d
        JOIN pg_catalog.pg_stat_activity activity ON activity.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
        WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
      `, [excludedRoles, sessionName, String(statementTimeoutMillis)]),
      previous && observeServer(previous, false)]);
      checkMaintenance();
      if (target?.name !== database || !target.safe || (profile && target.login !== profile.role)) {
        throw new DatabaseError("Query credentials are unavailable for this database", "QUERY_DATABASE_UNAVAILABLE");
      }
      if (target.oid !== oid) {
        throw new DatabaseError("The API key scope no longer matches this database", "DATABASE_SCOPE_CHANGED");
      }
      if (previous) {
        if (target.pid !== previous.pid || target.startedAt !== previous.startedAt ||
            target.serverStartedAt !== previous.serverStartedAt) {
          throw new DatabaseError("The pooled query backend changed", "QUERY_DATABASE_UNAVAILABLE");
        }
        if (ownerId !== undefined) previous.ownerId = ownerId;
      } else {
        await observeServer(target, true);
        const session = { ...target, idle: client.getTransactionStatus() === "I", ownerId };
        // ReadyForQuery distinguishes closed transactions from in-flight or open work.
        client.connection.on("readyForQuery", () => { session.idle = client.getTransactionStatus() === "I"; });
        backends.set(client, session);
      }
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

  function release(client: PoolClient, destroy: boolean) {
    if (destroy || closing) {
      client.release(true);
      return;
    }
    // Reset asynchronously so cleanup consumes a pool slot without adding latency
    // to the response. Failed or interrupted resets always destroy the connection.
    async function reset() {
      const command = (text: string) => {
        queryDispatched(client);
        const statement = { text, query_timeout: connectionTimeoutMillis };
        return client.query(statement);
      };
      if (!backends.get(client)?.idle) await command("ROLLBACK");
      await command("DISCARD ALL");
    }
    void reset().then(() => client.release(), (error) => {
      log.warn({ err: error }, "Could not reset the PostgreSQL query session");
      client.release(true);
    });
  }

  const warmFailures = new Set<string>();
  const targets = [
    ...Object.keys(config.database.queryUrls).map((database) => ({ database, scopes: null })),
    ...Object.entries(config.database.queryProfiles).flatMap(([database, profiles]) =>
      profiles.map(({ scopes }) => ({ database, scopes }))),
  ];

  async function warmPools() {
    for (const { database, scopes } of targets) {
      if (closing || queryConnections >= config.database.pool.maxGlobalQueries) break;
      const key = scopes ? scopeKey(scopes) : "";
      const pool = pools.get(database)?.get(key);
      const count = pool?.totalCount ?? 0;
      if (count >= config.database.pool.queryMin || maintenance.has(database)) continue;
      const target = `${database}:${key}`;
      try {
        const oid = await getPostgresDatabaseOid(database, adminDb);
        if (!oid) continue;
        const targetSize = Math.min(config.database.pool.queryMin,
          count + config.database.pool.maxGlobalQueries - queryConnections);
        const alreadyInUse = count - (pool?.idleCount ?? 0);
        // Hold all prewarmed clients until the connections have been opened.
        const clients = await Promise.allSettled(Array.from(
          { length: Math.max(0, targetSize - alreadyInUse) },
          () => connect(database, oid, scopes),
        ));
        for (const client of clients) if (client.status === "fulfilled") client.value.release();
        const failed = clients.find((client) => client.status === "rejected");
        if (failed) throw failed.reason;
        warmFailures.delete(target);
      } catch (error) {
        if (!closing && !warmFailures.has(target)) log.warn({ err: error, database }, "Could not prewarm query connections");
        warmFailures.add(target);
      }
    }
  }

  function warm() {
    if (closing || config.database.pool.queryMin === 0 || targets.length === 0) return;
    function replenish() {
      if (!closing && !warming) warming = warmPools().finally(() => { warming = undefined; });
      return warming;
    }
    warmTimer ??= setInterval(replenish, 5_000).unref();
    return replenish();
  }

  async function close() {
    closing = true;
    clearInterval(warmTimer);
    try {
      await warming;
      await Promise.all([...pools.keys()].map(evict));
    } finally {
      closed = true;
      clearTimeout(closeCheck);
      queryConnections -= closingBackends.size;
      closingBackends.clear();
    }
  }

  return { connect, queryDispatched, release, warm, withMaintenance, capacity, close };
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
