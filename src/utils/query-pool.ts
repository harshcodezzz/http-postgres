import { randomUUID } from "node:crypto";
import { Client, DatabaseError as PostgresError, Pool, type PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import config from "../config/index.js";
import { scopedInheritanceSafety, scopedQueryUrl, scopedRoleSafety, type QueryAccess } from "./query-access.js";
import { DatabaseError, getPostgresDatabaseOid } from "./pg-database.js";

const connectionTimeoutMillis = 10_000;
const checkoutTimeoutMillis = 5_000;
const growthIntervalMillis = 0;
const maxConcurrentOpenings = 4;
const statementTimeoutMillis = 30_000;
const queryTimeoutMillis = 35_000;
// Only a verified address and PostgreSQL system identifier may release a slot
// from a previous postmaster. An unrelated observer still fails closed.
const observerIdentitySql = `CASE
  WHEN pg_catalog.has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE')
  THEN pg_catalog.json_build_array(
    (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text,
    pg_catalog.inet_server_addr(),
    pg_catalog.current_setting('port'),
    pg_catalog.pg_is_in_recovery(),
    CASE WHEN pg_catalog.has_function_privilege('pg_catalog.pg_control_checkpoint()', 'EXECUTE')
      THEN (pg_catalog.pg_control_checkpoint()).timeline_id END
  )::pg_catalog.text
END`;
let queryConnections = 0;

interface BackendSession {
  pid: number;
  oid: string;
  startedAt: string | null;
  applicationName: string;
  serverStartedAt: string;
  observerIdentity: string | null;
  idle: boolean;
  ownerId?: string;
}

interface CheckoutWaiter {
  verify(client: PoolClient): Promise<BackendSession>;
  serve(client: PoolClient, verified?: BackendSession): Promise<void>;
  retry(): void;
  fail(error: unknown): void;
}

interface ManagedPool {
  pool: Pool;
  waiters: Set<CheckoutWaiter>;
  nextOpeningAt: number;
  openingCount: number;
  reclaiming: boolean;
  scheduled: boolean;
  retired: boolean;
  growthTimer?: NodeJS.Timeout;
}

export function createQueryPools(adminDb: Pool, adminRoles: string[], log: FastifyBaseLogger) {
  const pools = new Map<string, Map<string, ManagedPool>>();
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
  let checkoutTimeouts = 0;
  let pendingCheckouts = 0;
  let warmTimer: NodeJS.Timeout | undefined;
  let warming: Promise<void> | undefined;
  let closing = false;
  let closed = false;

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
      if (queryConnections >= config.database.pool.maxGlobalQueries) {
        throw new DatabaseError("The gateway query connection budget is exhausted", "QUERY_CONNECTION_LIMIT");
      }
      queryConnections++;
      try {
        const client = await super.connect();
        reservedClients.add(client);
        return client;
      } catch (error) {
        queryConnections--;
        wakePools();
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
        .reduce((count, state) => count + state.pool.idleCount, 0),
      pendingCheckouts,
      checkoutTimeouts,
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
          observerIdentity: string | null;
          pid: number | null;
          oid: string | null;
          startedAt: string | null;
          state: string | null;
          applicationName: string | null;
        }>(`
          SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text AS "serverStartedAt",
                 ${observerIdentitySql} AS "observerIdentity",
                 activity.pid, activity.datid::pg_catalog.text AS oid, activity.state,
                 EXTRACT(EPOCH FROM activity.backend_start)::pg_catalog.text AS "startedAt",
                 activity.application_name AS "applicationName"
          FROM (SELECT 1) AS server LEFT JOIN pg_catalog.pg_stat_activity AS activity
            ON activity.pid = ANY($1::pg_catalog.int4[])
        `, [sessions.map(({ pid }) => pid)]);
        if (closed) return;
        const observedServer = rows[0]?.serverStartedAt;
        const observedIdentity = rows[0]?.observerIdentity;
        if (!observedServer) throw new Error("PostgreSQL did not identify the monitoring server");
        const byPid = new Map(rows.map((row) => [row.pid, row]));
        for (const session of sessions) {
          if (session.serverStartedAt !== observedServer) {
            const sameServer = observedIdentity !== null &&
              session.observerIdentity !== null &&
              observedIdentity === session.observerIdentity;
            if (sameServer && Number(observedServer) > Number(session.serverStartedAt)) {
              if (closingBackends.delete(session)) {
                queryConnections--;
                wakePools();
              }
            } else {
              serverMismatch = true;
            }
            continue;
          }
          const current = byPid.get(session.pid);
          const original = current?.oid === session.oid &&
            (current.startedAt === null || current.startedAt === session.startedAt);
          // A session-mode proxy may keep the backend after it resets the client session.
          const reset = current?.state === "idle" && current.applicationName !== session.applicationName;
          if ((!original || reset) && closingBackends.delete(session)) {
            queryConnections--;
            wakePools();
          }
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
      await Promise.all([...databasePools.values()].map((state) => {
        state.retired = true;
        clearTimeout(state.growthTimer);
        for (const waiter of state.waiters) {
          waiter.fail(new DatabaseError("Database maintenance is in progress", "DATABASE_IN_USE"));
        }
        return state.pool.end();
      }));
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

  async function reclaimIdleConnection(requested: Pool | undefined) {
    for (const group of pools.values()) {
      for (const state of group.values()) {
        const { pool } = state;
        if (pool === requested || state.retired || state.waiters.size ||
            pool.totalCount <= (pool.options.min ?? 0) || pool.idleCount <= pool.waitingCount) continue;
        const client = await pool.connect().catch(() => undefined);
        if (client) {
          if (state.retired || state.waiters.size || pool.totalCount <= (pool.options.min ?? 0)) {
            client.release();
            continue;
          }
          await removeClient(pool, client);
          return true;
        }
      }
    }
    return false;
  }

  function wakePools() {
    for (const group of pools.values()) for (const state of group.values()) wake(state);
  }

  async function grow(state: ManagedPool, waiter: CheckoutWaiter) {
    let client: PoolClient | undefined;
    let session: BackendSession;
    try {
      client = await state.pool.connect();
      session = await waiter.verify(client);
    } catch (error) {
      client?.release(true);
      if (state.waiters.has(waiter) && !(error instanceof DatabaseError && error.code === "QUERY_CONNECTION_LIMIT")) {
        waiter.fail(error);
      }
      return;
    }
    // Waiters can use an existing session while the new connection is opening.
    if (state.waiters.delete(waiter)) await waiter.serve(client, session);
    else client.release();
  }

  function wake(state: ManagedPool) {
    if (closing || state.retired || state.scheduled || !state.waiters.size) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      if (closing || state.retired) return;
      const { pool, waiters } = state;
      function lend(waiter: CheckoutWaiter) {
        waiters.delete(waiter);
        return pool.connect().then((client) => waiter.serve(client), (error) => {
          if (error instanceof DatabaseError && error.code === "QUERY_CONNECTION_LIMIT") waiter.retry();
          else waiter.fail(error);
        });
      }
      for (const waiter of waiters) {
        if (pool.idleCount <= pool.waitingCount) break;
        void lend(waiter);
      }
      if (pool.totalCount + state.openingCount >= config.database.pool.max) return;
      while (state.openingCount < maxConcurrentOpenings && (pool.totalCount + state.openingCount) < config.database.pool.max) {
        const waiterToGrow = Array.from(state.waiters)[state.openingCount];
        if (!waiterToGrow) break;
        if (queryConnections + state.openingCount >= config.database.pool.maxGlobalQueries) {
          if (!state.reclaiming) {
            state.reclaiming = true;
            void reclaimIdleConnection(pool).then((reclaimed) => {
              state.reclaiming = false;
              if (reclaimed) wake(state);
            }, (err) => {
              state.reclaiming = false;
              log.warn({ err }, "Could not reclaim an idle PostgreSQL query connection");
            });
          }
          break;
        }
        state.openingCount++;
        state.nextOpeningAt = performance.now() + growthIntervalMillis;
        void grow(state, waiterToGrow).finally(() => {
          state.openingCount--;
          wake(state);
        });
      }
    });
  }

  function checkout(
    state: ManagedPool,
    ownerId: string | undefined,
    verify: (client: PoolClient) => Promise<BackendSession>,
    signal?: AbortSignal,
  ): Promise<PoolClient> {
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + checkoutTimeoutMillis;
      let settled = false;
      pendingCheckouts++;

      function finish() {
        settled = true;
        pendingCheckouts--;
        state.waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
      function cancel() {
        waiter.fail(signal?.reason);
      }
      function expire() {
        if (settled) return;
        checkoutTimeouts++;
        let code = "QUERY_POOL_WAIT_TIMEOUT";
        if (state.pool.totalCount >= config.database.pool.max) {
          rejectionsAtPoolLimit++;
          code = "QUERY_POOL_BUSY";
        } else if (queryConnections >= config.database.pool.maxGlobalQueries) {
          rejectionsAtLimit++;
          code = "QUERY_CONNECTION_LIMIT";
        }
        waiter.fail(new DatabaseError(`Timed out after ${checkoutTimeoutMillis} ms waiting for a PostgreSQL query connection`, code));
      }

      const waiter: CheckoutWaiter = {
        verify,
        fail(error) {
          if (settled) return;
          finish();
          reject(error);
        },
        retry() {
          if (settled) return;
          if (closing || state.retired) {
            waiter.fail(new DatabaseError("Database maintenance is in progress", "DATABASE_IN_USE"));
          } else if (performance.now() >= deadline) expire();
          else {
            state.waiters.add(waiter);
            wake(state);
          }
        },
        async serve(client, verified) {
          if (performance.now() >= deadline) expire();
          const previous = backends.get(client);
          if (settled && previous) {
            client.release();
            return;
          }
          if (previous?.ownerId && previous.ownerId !== ownerId) {
            // PostgreSQL extensions can hold backend-local state beyond DISCARD ALL.
            client.release(true);
            waiter.retry();
            return;
          }
          let session: BackendSession;
          try {
            session = verified ?? await verify(client);
          } catch (error) {
            client.release(true);
            waiter.fail(error);
            return;
          }
          if (performance.now() >= deadline) expire();
          if (settled) {
            // A slow connection still becomes warm for later requests.
            client.release();
            return;
          }
          session.ownerId = ownerId;
          finish();
          resolve(client);
        },
      };
      const timer = setTimeout(expire, checkoutTimeoutMillis).unref();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else waiter.retry();
    });
  }

  async function observeServer(session: Omit<BackendSession, "idle" | "observerIdentity">, opening: boolean) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows: [observer] } = await adminDb.query<{ verified: boolean; identity: string | null }>(`
        SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text = $4 AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE pid = $1 AND datid = $2::pg_catalog.oid
            AND ($3::pg_catalog.text IS NULL OR application_name = $3)
            AND (backend_start IS NULL OR EXTRACT(EPOCH FROM backend_start)::pg_catalog.text = $5)
        ) AS verified, CASE WHEN $3::pg_catalog.text IS NOT NULL THEN ${observerIdentitySql} END AS identity
      `, [session.pid, session.oid, opening ? session.applicationName : null, session.serverStartedAt, session.startedAt]);
      if (observer?.verified) {
        return observer.identity;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new DatabaseError("The query backend is not on the administrative PostgreSQL server", "QUERY_DATABASE_UNAVAILABLE");
  }

  async function connect(
    database: string,
    oid: string,
    access: QueryAccess | null = null,
    ownerId?: string,
    signal?: AbortSignal,
    statementTimeoutMs = statementTimeoutMillis,
  ): Promise<PoolClient> {
    function checkMaintenance() {
      if (closing || maintenance.has(database)) {
        throw new DatabaseError("Database maintenance is in progress", "DATABASE_IN_USE");
      }
    }
    checkMaintenance();

    const defaultUrl = Object.hasOwn(config.database.queryUrls, database)
      ? config.database.queryUrls[database]
      : undefined;
    const connectionString = access ? scopedQueryUrl(database, access) : defaultUrl;
    if (!connectionString) {
      throw new DatabaseError("Query credentials are unavailable for this database", "QUERY_DATABASE_UNAVAILABLE");
    }
    let databasePools = pools.get(database);
    if (!databasePools) {
      databasePools = new Map();
      pools.set(database, databasePools);
    }
    const poolKey = access?.login ?? "";
    let state = databasePools.get(poolKey);
    if (!state) {
      const pool = new Pool({
        connectionString,
        Client: BudgetedClient,
        pipeline: false,
        max: config.database.pool.max,
        min: access ? Math.min(config.database.pool.queryMin, 5) : config.database.pool.queryMin,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
        connectionTimeoutMillis,
        query_timeout: queryTimeoutMillis,
      });
      const managed: ManagedPool = {
        pool, waiters: new Set(), nextOpeningAt: 0,
        openingCount: 0, reclaiming: false, scheduled: false, retired: false,
      };
      const checkedOutError = (err: Error) => log.warn({ err, database }, "Checked-out query connection error");
      pool.on("acquire", (client: PoolClient) => client.on("error", checkedOutError));
      pool.on("release", (_err: Error | undefined, client: PoolClient) => {
        client.removeListener("error", checkedOutError);
        if (pendingCheckouts && queryConnections >= config.database.pool.maxGlobalQueries &&
            pool.totalCount > (pool.options.min ?? 0)) wakePools();
        else wake(managed);
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
          wakePools();
        }
        if (!access && warmTimer && !closing && !managed.retired && pool.totalCount < config.database.pool.queryMin) {
          queueMicrotask(() => { void replenish(); });
        }
      });
      state = managed;
      databasePools.set(poolKey, state);
    }

    const managed = state;
    function checkPool() {
      checkMaintenance();
      if (managed.retired) throw new DatabaseError("Database maintenance is in progress", "DATABASE_IN_USE");
    }
    async function verify(client: PoolClient): Promise<BackendSession> {
      checkPool();
      const previous = backends.get(client);
      const sessionName = previous?.applicationName ?? `http-postgres-${randomUUID()}`;
      queryDispatched(client);
      const [{ rows: [target] }] = await Promise.all([client.query<Omit<BackendSession, "idle" | "observerIdentity"> & {
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
          )
          ${access ? `AND (${scopedRoleSafety("session_user")}) AND ${scopedInheritanceSafety("session_user")}` : ""}
          AS safe,
          activity.pid,
          EXTRACT(EPOCH FROM activity.backend_start)::pg_catalog.text AS "startedAt",
          EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::pg_catalog.text AS "serverStartedAt",
          pg_catalog.set_config('application_name', $2, false) AS "applicationName",
          pg_catalog.set_config('statement_timeout', $3, false)
        FROM pg_catalog.pg_database d
        JOIN pg_catalog.pg_stat_activity activity ON activity.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
        WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
      `, [adminRoles, sessionName, String(statementTimeoutMs)]),
      previous && observeServer(previous, false)]);
      checkPool();
      if (target?.name !== database || !target.safe || (access && target.login !== access.login)) {
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
        return previous;
      }
      const observerIdentity = await observeServer(target, true);
      const session = { ...target, observerIdentity, idle: client.getTransactionStatus() === "I" };
      // ReadyForQuery distinguishes closed transactions from in-flight or open work.
      client.connection.on("readyForQuery", () => { session.idle = client.getTransactionStatus() === "I"; });
      backends.set(client, session);
      checkPool();
      return session;
    }

    if (ownerId !== undefined || signal) return checkout(managed, ownerId, verify, signal);
    const client = await managed.pool.connect();
    try {
      await verify(client);
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
  const targets = Object.keys(config.database.queryUrls);

  async function warmPools() {
    for (const database of targets) {
      if (closing) break;
      const pool = pools.get(database)?.get("")?.pool;
      const count = pool?.totalCount ?? 0;
      if (count >= config.database.pool.queryMin || maintenance.has(database)) continue;
      try {
        if (queryConnections >= config.database.pool.maxGlobalQueries && !await reclaimIdleConnection(pool)) continue;
        const oid = await getPostgresDatabaseOid(database, adminDb);
        if (!oid) continue;
        const targetSize = Math.min(config.database.pool.queryMin,
          count + config.database.pool.maxGlobalQueries - queryConnections);
        const alreadyInUse = count - (pool?.idleCount ?? 0);
        // Hold all prewarmed clients until the connections have been opened.
        const clients = await Promise.allSettled(Array.from(
          { length: Math.max(0, targetSize - alreadyInUse) },
          () => connect(database, oid),
        ));
        for (const client of clients) if (client.status === "fulfilled") client.value.release();
        const failed = clients.find((client) => client.status === "rejected");
        if (failed) throw failed.reason;
        warmFailures.delete(database);
      } catch (error) {
        if (!closing && !warmFailures.has(database)) log.warn({ err: error, database }, "Could not prewarm query connections");
        warmFailures.add(database);
      }
    }
  }

  function replenish() {
    if (!closing && !warming) warming = warmPools().finally(() => { warming = undefined; });
    return warming;
  }

  function warm() {
    if (closing || config.database.pool.queryMin === 0 || targets.length === 0) return;
    warmTimer ??= setInterval(replenish, 1_000).unref();
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

export function queryExecutionError(error: unknown, readOnlyRestricted = false) {
  const pgCode = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const forbidden = pgCode === "42501" || (readOnlyRestricted && pgCode === "25006");
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
