# Configuration

Start the gateway from the project root. It loads `.env` and reads `gateway.yaml` from the working directory. Environment variables set before startup take precedence over `.env`.

Self-hosted deployments need Node.js 22.13+ on the 22.x line or Node.js 23.4+, with the built-in `node:sqlite` module enabled. The gateway validates both requirements at startup before connecting to PostgreSQL.

YAML string values can reference an environment variable as `${NAME}` or supply a fallback as `${NAME:-fallback}`. A missing variable without a fallback prevents startup. An empty variable counts as set. Substitution produces strings, so use YAML numbers and booleans for numeric and boolean fields.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string referenced by the supplied YAML. The local fallback is `postgresql://postgres:postgres@127.0.0.1:5432/postgres`. |
| `REDIS_URL` | Redis connection string referenced by the supplied YAML. The local fallback is `redis://127.0.0.1:6379`. |
| `LOG_LEVEL` | Minimum Pino level produced by the gateway. Defaults to `info`. Stdout receives messages at this level and above; rotating failure files accept only `error` and `fatal` messages. |

## Complete configuration file

The shipped [gateway.yaml](../gateway.yaml) declares every supported option. The example below uses the values supplied by the repository; some pool values are intentionally higher than the loader defaults listed in the reference table.

```yaml
version: 1

server:
  host: "0.0.0.0"
  port: 8080
  shutdownDeadlineMillis: 30000

database:
  url: "${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
  exposeErrorDetails: false
  queryUrls: {}
  pool:
    min: 2
    queryMin: 2
    max: 50
    maxGlobalQueries: 100
    connectionTimeoutMillis: 10000
    checkoutTimeoutMillis: 10000
    growthIntervalMillis: 0
    maxConcurrentOpenings: 4
    statementTimeoutMillis: 30000
    queryTimeoutMillis: 35000

redis:
  enabled: true
  mode: external
  url: "${REDIS_URL:-redis://127.0.0.1:6379}"

ratelimit:
  enabled: true
  requestPerMinute: 1000
  requestPerMinutePerIp: 1000
  whitelistedIPs: []

transactions:
  retentionDays: 30

analytics:
  enabled: true
  directory: "./data/analytics"
  retentionDays: 30
  maxStorageBytes: 67108864
  storeFullSql: false
```

To configure default query logins, replace the empty map with database-name-to-URL entries. Each URL must include the target database:

```yaml
database:
  queryUrls:
    reporting: "${REPORTING_QUERY_URL}"
    warehouse: "${WAREHOUSE_QUERY_URL}"
```

## YAML settings

The table lists loader defaults. Explicit values in [gateway.yaml](../gateway.yaml) take precedence.

| Setting | Default | Behavior |
| --- | --- | --- |
| `version` | Required | Positive integer identifying the configuration format. The supplied file uses `1`. |
| `server.host` | `0.0.0.0` | Listen address. Use `127.0.0.1` for loopback-only access. |
| `server.port` | `8080` | Listen port from 1 to 65535. |
| `server.shutdownDeadlineMillis` | `30000` | Maximum graceful-shutdown time before forced exit, from 1000 through 300000 milliseconds. A second termination signal still exits immediately. |
| `database.url` | Required | Administrative PostgreSQL connection string. The gateway checks it at startup. |
| `database.exposeErrorDetails` | `false` | Exposes PostgreSQL detail and hint text to authenticated query callers when enabled. |
| `database.queryUrls` | `{}` | Map of database names to default query-login URLs used by name-only keys. Keys must match `^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`; every value must be a non-empty connection string. |
| `database.pool.min` | `2` | Minimum size of the administrative pool, zero or greater. |
| `database.pool.queryMin` | `1` | Number of connections the gateway prewarms and replenishes per configured default query login. Set to `0` to open them on demand. The minimum cannot exceed the per-pool maximum and prewarming shares the global budget. |
| `database.pool.max` | `20` | Maximum size of the administrative pool and of each query pool. A database has a separate pool for its default login and each scoped login. The minimum cannot exceed the maximum. |
| `database.pool.maxGlobalQueries` | `40` | Process-wide budget across all databases and logins. Includes opening, idle, busy, and unverified closing query connections. Excludes the administrative pool. Reusing an idle session consumes its existing slot. The gateway can reclaim idle connections above another pool's minimum. |
| `database.pool.connectionTimeoutMillis` | `10000` | Maximum time in milliseconds for opening a physical PostgreSQL query connection. |
| `database.pool.checkoutTimeoutMillis` | `10000` | Maximum time in milliseconds a request waits to acquire and verify a pooled query connection before receiving a `503` connection error. |
| `database.pool.growthIntervalMillis` | `0` | Minimum delay in milliseconds before a query pool schedules another connection opening. Set to `0` to allow immediate growth. |
| `database.pool.maxConcurrentOpenings` | `4` | Maximum number of physical connections a single query pool may open concurrently while requests are waiting. |
| `database.pool.statementTimeoutMillis` | `30000` | Default PostgreSQL `statement_timeout` applied to query sessions. |
| `database.pool.queryTimeoutMillis` | `35000` | Client-side timeout in milliseconds for PostgreSQL query operations on pooled connections. |
| `redis.enabled` | `true` | Connect to Redis on startup. Set to `false` to use an in-memory store local to the gateway process. |
| `redis.mode` | `external` | Accepts `external` or `managed`. Both currently connect to the configured Redis URL when enabled. |
| `redis.url` | Required when enabled | Redis connection string. |
| `ratelimit.enabled` | `true` | Enable the per-IP and per-key request limits. |
| `ratelimit.requestPerMinute` | `1000` | Requests per authenticated API key in a 60-second window. |
| `ratelimit.requestPerMinutePerIp` | `1000` | Requests per IP in a 60-second window. Applies before authentication. |
| `ratelimit.whitelistedIPs` | `[]` | IPv4 or IPv6 addresses and CIDR ranges exempt from the per-IP limit, such as `192.0.2.10`, `10.0.0.0/8`, `2001:db8::1`, or `2001:db8::/32`. |
| `transactions.retentionDays` | `30` | Days to keep uncollected async query outcomes, finalized transaction records, and idempotency tombstones. Accepts integers from `0` through `365000`; `0` disables age-based cleanup. |
| `analytics.enabled` | `true` | Collect query counts, per-key usage, and failed SQL. |
| `analytics.directory` | `./data/analytics` | Directory containing `analytics.sqlite`. |
| `analytics.retentionDays` | `30` | Maximum age of failed-query records, from `1` through `3650` days. Usage counters remain cumulative. |
| `analytics.maxStorageBytes` | `67108864` | Analytics storage quota in bytes. Database, WAL, shared-memory, and spool sizes are considered when pruning, and SQLite database pages are capped below the total allowance. Minimum 1 MiB. |
| `analytics.storeFullSql` | `false` | Store complete failed SQL when enabled. By default, a PostgreSQL-aware best-effort sanitizer removes comments and replaces string, dollar-quoted, and numeric literals. Do not treat analytics redaction as a substitute for parameterized SQL or access controls. |

### Validation rules

The gateway validates the complete file before opening network connections:

- `server.port` must be an integer from `1` through `65535`.
- `server.shutdownDeadlineMillis` must be an integer from `1000` through `300000`.
- `database.pool.min` and `database.pool.queryMin` must be zero or greater and cannot exceed `database.pool.max`.
- `database.pool.max`, `database.pool.maxGlobalQueries`, `database.pool.maxConcurrentOpenings`, and all pool timeout values must be positive integers. `database.pool.growthIntervalMillis` may be zero.
- `redis.mode` accepts only `external` or `managed`; `redis.url` is required whenever Redis is enabled.
- Both rate-limit counts must be positive integers. Whitelist entries must be valid IPv4 or IPv6 addresses with an optional valid CIDR prefix.
- `analytics.maxStorageBytes` must be at least `1048576` bytes (1 MiB).
- Unknown object keys are currently ignored by the schema. Do not rely on that behavior: misspelled settings will not configure the gateway.

All paths are resolved by the component that consumes them. Start the process from the intended project or deployment root so `gateway.yaml`, `data/`, `logs/`, and relative analytics paths resolve consistently.

When Redis rate limiting is enabled, the Redis user needs permission to run `EVAL`, `INCR`, `TTL`, and `EXPIRE` on the rate-limit keys.

When a query pool has waiting requests and no reusable session, it may open up to `maxConcurrentOpenings` connections concurrently. `growthIntervalMillis` controls the delay between scheduled openings. Requests have up to `checkoutTimeoutMillis` to acquire a verified PostgreSQL session before the gateway returns a `503` connection error. Physical connection attempts, PostgreSQL statements, and client-side query operations use their separately configured deadlines.

For a loopback-only development instance without Redis, set these fields in the existing YAML file.

```yaml
server:
  host: "127.0.0.1"
  port: 8080
redis:
  enabled: false
```

## Query database access

Configure a dedicated PostgreSQL login for each default connection in `queryUrls`. Give the login `CONNECT` on its database and the schema and object privileges needed by the queries. The gateway checks that the login is separate from the administrative roles, has no elevated role memberships, and lacks `CONNECT` on other connectable databases. PostgreSQL grants `CONNECT` to `PUBLIC` by default. On a shared cluster, grant access explicitly to the roles that need each database before revoking the public grant. Keep cross-database connections, foreign servers, and privileged routines out of the query login's grants. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

Use a direct PostgreSQL connection or a session-mode proxy that resets each backend session on client disconnect. The admin and query URLs must point to the same PostgreSQL server. The gateway verifies each query session through the administrative connection's `pg_stat_activity` view. If a session-mode proxy retains its backend connections, grant the administrative role `pg_read_all_stats` so the gateway can recognize when those sessions have reset after an interruption. Provide the full URL for each database, including its database name. Store credentials in environment variables and reference them from YAML.

```yaml
database:
  url: "${DATABASE_URL}"
  queryUrls:
    gateway_demo: "${QUERY_DEMO_URL}"
```

For CRUD-scoped API keys, the gateway uses `database.url` to provision restricted PostgreSQL logins on demand. The configured administrator needs `CREATEROLE` and permission to grant database, schema, table, and sequence access. Scoped logins use PostgreSQL password authentication and share the process-wide query connection limit.

PostgreSQL privileges are additive. Scoped logins need explicit grants for their selected database and must lack `CONNECT` to other connectable databases. Keep application tables, sequences, routines, and foreign servers private to their intended roles. On PostgreSQL 14 and earlier, revoke the default PUBLIC `CREATE` grant on the target database's `public` schema. Review the roles using these grants before changing privileges on a shared cluster. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

A renamed database keeps its CRUD-scoped key bindings. For a database served through `queryUrls`, configure the destination name and connection URL and restart the gateway.

### Recover query connection capacity

Poll authenticated `GET /admin/health` on each gateway process. Its `services.queryConnections` object reports reserved, idle, and available slots, requests waiting for a verified connection (`pendingCheckouts`), total checkout timeouts (`checkoutTimeouts`), slots awaiting verification, the age of the oldest one, and PostgreSQL monitoring status. `available` counts slots for opening new connections. `rejectionsAtLimit` counts timeouts at the process-wide limit since startup. `rejectionsAtPoolLimit` counts timeouts at the database login limit. The gateway logs the start and recovery of a monitoring failure. Compare the counters with `oldestUnverifiedMs` to tell load saturation from stuck backend verification.

Restore the administrative connection and its ability to inspect sessions on the PostgreSQL server that owns the interrupted backends. For `server_mismatch`, check that the admin and query URLs or proxies still target the same server. The gateway retries verification and releases slots as it confirms that sessions exited or reset. If the gateway must move to a replacement server, drain traffic and confirm that its old PostgreSQL sessions have ended or that the old server is offline before restarting the gateway against the replacement.

## How analytics works

Analytics is optional, local observability for query usage and failures. When `analytics.enabled` is `true`, the gateway starts a worker thread that owns a SQLite database in `analytics.directory`. Query execution does not wait for a SQLite write on every request: the main thread updates an in-memory buffer, and the worker normally flushes it within one second.

When analytics is disabled, the worker is not started, analytics files are not opened, and `GET /admin/analytics` returns `{"success":true,"enabled":false}`.

### What is counted

Analytics maintains cumulative usage per API-key record ID:

- `totalQueries` counts attempted query executions.
- `failedQueries` counts attempts whose recorded HTTP outcome status is `400` or greater.
- `lastUsedAt` is the latest recorded execution timestamp for that key ID.
- Gateway-wide totals are calculated by summing the per-key counters when a report is requested.

An immediate or asynchronous `/query` execution counts once. A transaction counts each statement that is attempted: successfully completed statements are counted individually, and the statement that fails is counted as a failure. Statements skipped after a transaction failure are not counted. Authentication, polling, result retrieval, deletion, health checks, admin operations, and idempotent replays do not increment query counters.

The counters are associated with the immutable API-key record ID, not the raw key. Revoking or permanently deleting an API key does not remove its historical analytics row. Usage counters are cumulative and are not removed by `analytics.retentionDays`; there is currently no analytics-reset endpoint.

### What is stored for failures

Successful SQL text is never stored. For a failed attempt, the gateway can store:

- API-key record ID and database name;
- HTTP status, gateway error code, and PostgreSQL SQLSTATE when available;
- occurrence timestamp;
- SQL text, limited to 8,192 characters, plus a `truncated` flag.

Bound parameter values are never included in analytics. With the default `storeFullSql: false`, a PostgreSQL-aware best-effort sanitizer removes line and block comments and replaces string literals, dollar-quoted bodies, and standalone numeric literals with `?`. Quoted identifiers and the remaining SQL structure are preserved. With `storeFullSql: true`, the original SQL string is retained, but bound parameters are still omitted.

Redaction is a risk-reduction measure, not a data-loss-prevention boundary. Identifiers, operators, function names, and literals the sanitizer does not recognize can remain visible. Use placeholders for sensitive values, restrict access to the analytics directory and admin API, and leave full-SQL storage disabled unless it is explicitly required.

The in-memory failure-detail buffer holds at most 256 entries. When it is full, the gateway continues updating cumulative usage and failure counters but drops additional failure-detail rows until the buffer drains, and writes a warning to the logger.

### Storage and flushing

The worker stores data in `analytics.sqlite` using SQLite WAL mode. It creates the analytics directory with owner-only permissions and the database file with mode `0600` where the operating system honors POSIX modes.

Normal flow:

1. A route reports a completed attempt to the in-memory analytics buffer.
2. At most one batch is in flight from the main thread at a time.
3. The one-second flush sends the batch to the worker.
4. The worker writes usage counters, failure rows, and a processed-batch marker in one SQLite transaction.
5. The batch marker makes a retry idempotent if the worker restarts after committing but before acknowledging the batch.

If the worker exits unexpectedly, the gateway restarts it with exponential backoff from 100 milliseconds up to 10 seconds and resubmits the unacknowledged batch. During graceful shutdown, the gateway gives the worker a bounded opportunity to flush. If SQLite remains unavailable, pending analytics can be written to `analytics-pending.json` in the same directory and loaded on the next startup. Analytics failures are logged but do not change the SQL execution result returned to the client.

Calling `GET /admin/analytics` first asks the current buffer to flush, waiting up to one second, and then reads a consistent report from the worker. If the worker is unavailable, the route returns `503 ANALYTICS_UNAVAILABLE`.

### Retention and storage quota

`analytics.retentionDays` applies only to individual failed-query rows. Old failure details are deleted in bounded batches during periodic maintenance. Per-key and gateway-wide counters remain cumulative.

`analytics.maxStorageBytes` accounts for:

- `analytics.sqlite`;
- its `-wal` and `-shm` files;
- `analytics-pending.json` when present.

Maintenance normally runs no more than once per minute and runs early when physical storage reaches 75% of the configured quota. It removes expired failures first, then the oldest remaining failure rows in bounded batches when space is still high. SQLite database pages are capped below the total quota so WAL, shared-memory, and spool files retain headroom. During emergency spooling, buffered failure details may be dropped to fit the quota; cumulative usage data is prioritized.

The quota is a safety bound, not an exact steady-state file size. SQLite page reuse, WAL checkpoints, filesystem allocation, and concurrent processes can produce temporary differences between logical and physical usage.

### Reading analytics

Send the administrator password in `x-admin`:

```sh
curl --fail-with-body \
  'http://localhost:8080/admin/analytics?limit=50' \
  -H 'x-admin: <admin-password>'
```

`limit` controls only `recentFailures`; it defaults to `50`, has a minimum effective value of `1`, and is capped at `200`. The per-key `keys` array always contains all cumulative key rows, ordered by total query count and then key ID.

```json
{
  "success": true,
  "enabled": true,
  "totalQueries": 128,
  "failedQueries": 3,
  "keys": [
    {
      "keyId": "a60b9666e0176392c5a2941b",
      "totalQueries": 128,
      "failedQueries": 3,
      "lastUsedAt": "2026-11-22T09:56:35.427Z"
    }
  ],
  "recentFailures": [
    {
      "keyId": "a60b9666e0176392c5a2941b",
      "database": "reporting",
      "query": "SELECT * FROM public.orders WHERE id = ?",
      "truncated": false,
      "status": 400,
      "code": "QUERY_EXECUTION_ERROR",
      "pgCode": "42P01",
      "occurredAt": "2026-11-22T09:55:00.000Z"
    }
  ]
}
```

Query analytics remains focused on usage and failures. Bounded HTTP latency buckets, request counts, process health, and gateway-managed pool utilization are available from authenticated `GET /admin/metrics`. Metrics intentionally omit client IPs, raw API keys, SQL labels, and unrestricted per-database labels.

### Multiple gateway processes

Processes on the same host may share an analytics directory only when the underlying local filesystem provides correct SQLite locking. A network filesystem is not automatically safe. Separate directories are the simpler isolation model, but each process then reports only its own counters and reports must be aggregated externally.

## Rebind existing API keys

Use `GET /admin/keys` to find the record ID of an active key that returns `API_KEY_SCOPE_REBIND_REQUIRED`. Verify that every intended database name refers to the correct PostgreSQL database. Then send `PATCH /admin/keys/:id` with the admin password in `x-admin` and the key's complete database assignment in the JSON body.

- For a name-only key, send `{"databases":["sales","events"]}`.
- For a key with explicit privileges, send the complete [CRUD scope](routes.md#api-key-database-and-table-scopes). Keys created with SQL privilege maps require rebinding before they can run queries.

The update refreshes the PostgreSQL identity bindings and preserves the key's record ID and secret. Verify the updated key against each intended database.

## Runtime files

| Path | Contents |
| --- | --- |
| `data/data.sqlite` | Versioned SQLite metadata containing the admin hash, API keys, database bindings and scopes, role mappings, and persistent cleanup schedule. |
| `data/data.sqlite-wal`, `data/data.sqlite-shm` | SQLite WAL coordination files while gateway processes are running. Include them in SQLite-aware snapshots. |
| `data/data.json.backup` | Retained pre-migration metadata backup for rollback. It is not rewritten after migration. |
| `data/analytics/analytics.sqlite` | Cumulative query counts by API key and failed SQL records. |
| `logs/failed.*.log` | Error-level gateway failures, rotated daily or at the configured `20m` size threshold. Routine informational logs are written only to stdout. |
| `logs/current.log` | Symlink to the active failure log. |
| `logs/api-keys.log` | Active API key audit events. Rotates at 5 MiB. |
| `logs/api-keys.log.1` | Previous audit log generation. |

Fastify's request completion logs print `responseTime` in milliseconds as a JSON string with three decimal places. Processes sharing metadata must use the same local-host SQLite database on a filesystem with correct WAL locking. Writers wait up to five seconds for a transaction. Do not place metadata on a network filesystem unless its SQLite semantics have been verified. Use a separate audit-log directory per process. Transaction queues are held in process memory and have no runtime file.

The gateway stores batch SQL, progress, and outcomes in `http_postgres_gateway.transactions`. It stores async query outcomes in `http_postgres_gateway.async_queries`. Both tables live in the administrative database. The administrative role must own the storage schema and its tables. A DBA can provision the schema with `CREATE SCHEMA http_postgres_gateway AUTHORIZATION gateway_admin`. If the schema is missing, the gateway needs database-level `CREATE` to provision it. Keep the schema private to the administrative role. Query and transaction records can be read repeatedly. Clients can delete finalized records explicitly, and age-based cleanup prunes them after the configured retention period. For executions that exceed their deadline without a stored outcome, the retention period starts at that deadline. Removing a keyed transaction record starts a separate retention window for its idempotency tombstone. For receipts whose records were removed before tombstones included the removal timestamp, cleanup uses the original submission time. Inputs and outcomes use base64-encoded JSON strings in JSONB columns, with older JSONB objects still readable. Deferred transaction queues remain process-local. New batch inputs omit bound values. Older receipts can contain original inputs until they are deleted or pruned. Async results still contain any values returned by the SQL itself.

See [How analytics works](#how-analytics-works) for buffering, failure redaction, worker recovery, retention, quotas, and multi-process behavior.
