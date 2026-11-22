# Changelog

## Unreleased

### Fixed

- Preserved pre-dispatch execution-limit errors in transaction commits, including `503 RESULT_MEMORY_BUSY`, instead of converting them to `400 QUERY_EXECUTION_ERROR`. Asynchronous transaction batches now classify these capacity failures as `failed` rather than `rejected`.

## 1.6.0 - 2026-11-22

### Added

- Added `GET /admin/analytics` for total and failed query counts, usage by API key ID, and recent failed SQL. Analytics stores SQL text only for failures.

### Changed

- Made `GET /query/:id` and `GET /transaction/:id` repeatable. Use `DELETE` on the same URL to remove a finalized record after receiving its result. Active executions return `409` on deletion.
- Omitted bound parameters from new transaction receipts and queue lookups. Bound values contribute to the idempotency fingerprint. Stored execution failures retain error codes and omit diagnostic text that can quote bound values.

### Fixed

- Provisioned unique PostgreSQL login roles per API key to prevent keys with identical scopes from inspecting each other's SQL queries and literal values in `pg_stat_activity`. Role cleanup on key deletion, revocation, or scope rotation is persisted, retried in the background, and reported by the admin API.
- Released stale query connection slots after a verified restart of the same PostgreSQL server, while failing closed when monitoring reaches a different or unidentified server.
- Strictly separated database name lookup from OID lookup in admin database endpoints, preventing numeric database names from resolving as OIDs and modifying unintended databases.
- Blocked `pg_logical_emit_message` and other administrative/replication functions during read-only query and transaction execution to prevent unauthorized WAL emissions.
- Enforced full read-only query guards and rejected large-object mutations (`lo_create`, `lo_from_bytea`, etc.) for transactions submitted with `options.readOnly: true`, regardless of API key write capabilities.
- Preserved provisioned username and password authentication credentials when connecting via Unix-socket database URLs.
- Moved SQLite analytics I/O to a worker thread so database locks cannot stall HTTP traffic. Shutdown uses a bounded flush and durably spools remaining analytics for the next process.
- Sorted recent analytics failure queries by event timestamp descending (`occurred_at DESC, id DESC`) rather than buffer flush order.
- Sanitized administrative database pool error logs and added logger redaction paths to prevent leaking internal PostgreSQL client properties, backend process IDs, and cancellation secret keys.
- Bounded concurrent and queued admin password verification to prevent scrypt requests from exhausting CPU and the Node.js worker pool.
- Stopped accepting HTTP requests before draining role cleanup during shutdown, with a bounded cleanup grace period.
- Preserved `Infinity`, `-Infinity`, and `NaN` in lossless `real[]` and `double precision[]` results while keeping SQL nulls distinct.
- Added acknowledged analytics backpressure and worker restart recovery, failed-query retention and storage quotas, default SQL literal redaction, and pre-decoding PostgreSQL row-message and concurrent result-memory limits.
- Added IPv4, IPv6, and CIDR matching for the rate-limit IP whitelist, with startup validation for invalid addresses and prefixes.
- Enabled rate limiting in the shipped configuration, added pre-write and `SQLITE_FULL` analytics pruning with physical-file accounting, removed SQL comments with tokenizer-based literal redaction, made analytics batches transactionally idempotent, and held result-memory reservations through response delivery.
- Bounded analytics worker shutdown even when fallback spooling fails, and distinguished pre-dispatch result-memory rejection from unknown PostgreSQL query outcomes.
- Defaulted newly created database-assigned API keys to CRUD access across all current user tables when no database or table scope fields are supplied.
- Returned pre-dispatch execution limits with their specific status and code, including `503 RESULT_MEMORY_BUSY`, instead of mapping them to a generic query error.
- Enforced table scopes across inheritance and partition trees, and rolled back writes attempted through read-only keys.
- Rejected API key provisioning when requested PostgreSQL grants are incomplete. Resaving a key now refreshes grants for replacement sequences used by column defaults.
- Required exact database name matches when looking up a database in admin routes, preventing overlong names from selecting a truncated match.
- Made abandoned transaction records eligible for explicit deletion and retention cleanup after their execution deadline.

## 1.5.0

### Added

- Added `type: "async"` to the query API. Accepted requests return a query ID, and PostgreSQL stores outcomes for later retrieval. Async statements have a five-minute PostgreSQL timeout.
- Added database and table CRUD scopes for API keys, backed by PostgreSQL logins provisioned from the requested grants.
- Added singular `/admin/database` routes for listing, inspecting, creating, and updating databases. `PUT /admin/database` refreshes the recorded collation version on PostgreSQL 15 and later.
- Added `GET /admin/table` for listing tables in the database selected by `x-database`.

### Changed

- Removed static `queryProfiles` configuration. Keys that used those profiles require rebinding to CRUD scopes.
- Finished async query and transaction records were removed by the first finalized GET in this version.

### Removed

- Removed `docs/throughput.md`.

## 1.0.0

- Introduced the HTTP PostgreSQL gateway with authenticated SQL queries, PostgreSQL connection pools, and optional Redis-backed rate limiting.
- Added queued transactions and persistent async transaction batches with idempotency keys, status polling, and retention cleanup.
- Added administrator routes for API keys, databases, health, and logs.
- Added result-format options, lossless value handling, query deadlines, and result-size limits.
- Added database-specific connection pools, prewarming, adaptive connection growth, and a process-wide query connection budget.
