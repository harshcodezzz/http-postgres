# Architecture

HTTP PostgreSQL Gateway is a persistent bridge between HTTP-only runtimes and PostgreSQL. Serverless and edge clients make stateless HTTPS requests while the gateway maintains reusable PostgreSQL connections on a network where TCP or Unix-socket database access is available.

The service also separates administrative database access from client query access. API-key scopes are translated into PostgreSQL roles, so PostgreSQL remains the final authorization boundary for SQL execution.

## Component overview

```text
Serverless / edge / HTTP-only client
    |
    | HTTPS + JSON
    v
Fastify server
    |-- authentication and rate limiting
    |-- admin routes
    |-- query routes
    `-- transaction routes
          |
          +--> PostgreSQL admin pool -----+
          +--> per-key query pools -------+--> PostgreSQL over TCP or Unix socket
          +--> Redis or in-memory rate-limit store
          +--> JSON metadata store + SQLite lock
          `--> SQLite analytics worker
```

### HTTP layer

Fastify owns request parsing, compression, routing, error responses, and lifecycle hooks. Authentication runs before protected routes. Public access is limited to `GET` and `HEAD /health`.

The caller does not need a PostgreSQL driver or socket API. It must be able to keep the HTTP request open for the selected execution mode, or submit asynchronous work and poll later.

### Administrative PostgreSQL pool

The connection in `database.url` verifies database identities, manages gateway persistence tables, performs administrative routes, and provisions restricted roles for scoped API keys. It is intentionally separate from the sessions that execute client SQL.

### Query pools

Client SQL runs through pools selected by database and access identity. The gateway verifies each session before use, applies execution limits, and resets reusable sessions after a request. A process-wide budget bounds all query connections in addition to each pool's maximum.

### API-key metadata

`data/data.json` stores the administrator password hash, API-key records, database identity bindings, and the secret material needed to derive credentials for scoped PostgreSQL roles. A SQLite lock file coordinates writers. This file is security-sensitive and operationally essential.

### Rate-limit store

Redis provides shared counters for deployments with multiple processes. When Redis is disabled, an in-memory implementation provides the same interface but all state is local to one process and disappears on restart.

### Analytics

Query counters and failed-query records are written to SQLite through a worker thread. Writes are buffered, storage is bounded, and failed SQL is sanitized by default. Analytics is observability data, not an authorization or execution dependency.

## Request lifecycle

An authenticated query follows this path:

1. The per-IP limiter evaluates the request unless the address is allowlisted.
2. Authentication validates the raw API key and requested database.
3. The per-key limiter applies its request window.
4. The gateway resolves the key's database identity and PostgreSQL access role.
5. A verified query session is checked out within the connection deadline.
6. SQL policy and execution limits are applied, then PostgreSQL executes the statement.
7. Results are converted to the configured representation and checked against row and memory budgets.
8. Analytics records the attempt or failure.
9. The session is rolled back if necessary, reset, and either returned to the same key's pool or closed.

Administration requests use the administrator password and administrative pool instead of an API-key query pool.

## Execution and durability

| Work type | Queue/input location | Outcome location | Restart behavior |
| --- | --- | --- | --- |
| Immediate query | Request memory | HTTP response | No replay; the outcome may be unknown after an interruption |
| Async query | Process scheduler | PostgreSQL gateway tables | Record survives; interrupted work is not automatically replayed |
| Submitted atomic batch | Process scheduler | PostgreSQL gateway tables | Record survives; interrupted work is not automatically replayed |
| Editable queued transaction | Process memory | Process memory until commit submission | Uncommitted queue is lost on restart |

The durable tables live in the administrative database under `http_postgres_gateway`. Inputs and outcomes are encoded into JSONB records. Retention cleanup removes old finalized records according to configuration.

## Transaction lifecycle

Atomic batches are accepted with an idempotency key, fingerprinted, stored, and scheduled. The gateway stages results before issuing `COMMIT`; results are exposed only after commit confirmation and a successful status update. If commit confirmation is lost, the status can become `unknown`. Clients must verify the database state rather than blindly resubmit.

Queued transactions have a different purpose: clients create an in-memory queue, add or remove individual statements, then add `COMMIT` to execute the entire queue on one connection. They are convenient for interactive construction but are not durable before submission.

## Scaling boundaries

- PostgreSQL-backed execution records can be read by any process with the same administrative database and key metadata.
- `data/data.json` may be shared only through storage that supports the locking and atomic-rename semantics described in [Configuration](configuration.md#runtime-files).
- Redis is required for rate-limit counters shared across processes.
- Queued transactions and the in-memory fallback store are process-local, so routing a workflow across replicas is unsafe without session affinity.
- Analytics can share a local directory among processes on one host when the filesystem provides SQLite locking. Separate directories produce separate counters.

See [Deployment](deployment.md) for topology recommendations and [Security](security.md) for trust boundaries.
