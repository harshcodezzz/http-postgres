# Changelog

## Unreleased

### Added

- Added `GET /admin/analytics` for total and failed query counts, usage by API key ID, and recent failed SQL. Analytics stores SQL text only for failures.

### Changed

- Made `GET /query/:id` and `GET /transaction/:id` repeatable. Use `DELETE` on the same URL to remove a finalized record after receiving its result. Active executions return `409` on deletion.
- Omitted bound parameters from new transaction receipts and queue lookups. Bound values contribute to the idempotency fingerprint. Stored execution failures retain error codes and omit diagnostic text that can quote bound values.

### Fixed

- Provisioned unique PostgreSQL login roles per API key to prevent keys with identical scopes from inspecting each other's SQL queries and literal values in `pg_stat_activity`, and deprovisioned roles on key deletion, revocation, or scope rotation.
- Released stale query connection slots and recovered monitoring when PostgreSQL restarts mid-query instead of leaking slot budgets with `503 QUERY_CONNECTION_LIMIT`.
- Strictly separated database name lookup from OID lookup in admin database endpoints, preventing numeric database names from resolving as OIDs and modifying unintended databases.
- Blocked `pg_logical_emit_message` and other administrative/replication functions during read-only query and transaction execution to prevent unauthorized WAL emissions.
- Enforced full read-only query guards and rejected large-object mutations (`lo_create`, `lo_from_bytea`, etc.) for transactions submitted with `options.readOnly: true`, regardless of API key write capabilities.
- Preserved provisioned username and password authentication credentials when connecting via Unix-socket database URLs.
- Hardened SQLite analytics database flushing and shutdown handling with `busy_timeout` configuration and lock retries that continue until buffered metrics and failed queries are persisted.
- Sorted recent analytics failure queries by event timestamp descending (`occurred_at DESC, id DESC`) rather than buffer flush order.
- Sanitized administrative database pool error logs and added logger redaction paths to prevent leaking internal PostgreSQL client properties, backend process IDs, and cancellation secret keys.
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
