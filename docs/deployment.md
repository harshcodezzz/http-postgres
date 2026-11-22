# Deployment

This guide covers the operational requirements for the persistent side of a serverless architecture. The gateway can run as a system service or container, but the repository does not prescribe a particular platform.

## Recommended topology

Place a TLS-terminating reverse proxy or load balancer in front of one or more long-running gateway processes. Serverless callers reach the public query endpoint over HTTPS; the gateway reaches PostgreSQL over private TCP or a Unix socket. Keep PostgreSQL and Redis on private networks. Restrict administrative routes to an operator network even when query routes are externally reachable.

Do not run a fresh gateway inside each serverless invocation. Its value comes from maintaining connection pools and durable operational state outside short-lived functions.

For the simplest reliable deployment, start with one gateway process, one persistent runtime-data volume, PostgreSQL, and Redis. Add replicas only after accounting for process-local queued transactions, local metadata locking, analytics aggregation, and rate-limit sharing.

## Build an artifact

Install exactly the locked dependencies and compile TypeScript:

```sh
npm ci
npm run build
```

Start the compiled application from the repository root so it can find `gateway.yaml`:

```sh
npm start
```

The runtime artifact needs `dist/`, production dependencies, `package.json`, and `gateway.yaml`. It also needs writable locations for `data/`, `logs/`, and the configured analytics directory. Supply secrets at runtime rather than copying `.env` into an image.

## Pre-deployment checklist

- [ ] A supported Node.js build includes `node:sqlite`.
- [ ] `DATABASE_URL` points to the intended PostgreSQL server and administrative database.
- [ ] Redis is configured and reachable, or process-local behavior has been explicitly accepted.
- [ ] PostgreSQL public privileges and administrative grants have been reviewed.
- [ ] `data/`, `logs/`, and analytics paths are writable only by the service account.
- [ ] Persistent execution tables can be created in the `http_postgres_gateway` schema.
- [ ] The reverse proxy enforces TLS, request-size limits, and administrative route restrictions.
- [ ] Pool limits fit inside the PostgreSQL connection budget.
- [ ] Backup, restore, monitoring, and graceful-shutdown procedures have been exercised.

## Persistent state

| State | Location | Backup expectation |
| --- | --- | --- |
| Admin hash, API-key records, scoped-role secret | `data/data.json` | Required; encrypt and back up consistently |
| Async and batch execution records | PostgreSQL `http_postgres_gateway` schema | Include in normal PostgreSQL backups |
| Analytics | `data/analytics/analytics.sqlite` by default | Optional, according to observability retention requirements |
| Logs and API-key audit trail | `logs/` | Ship or retain according to audit policy |
| Queued transactions before commit | Process memory | Not recoverable; clients must recreate them |
| Rate-limit counters | Redis or process memory | Normally ephemeral |

Do not restore `data/data.json` from a different logical environment without also verifying its API-key database identity bindings and provisioned PostgreSQL roles.

## Health checks

Use `GET /health` as a lightweight process liveness check. It does not validate dependencies.

Use authenticated `GET /admin/health` for readiness and operator monitoring. It reports PostgreSQL, key-value storage, JsonDB, query-session monitoring, and capacity counters. Alert on a degraded status, checkout timeouts, sustained pending checkouts, or growing unverified-session age.

Do not place the administrator password in load-balancer configuration that is broadly readable. A private monitoring agent or a narrowly scoped secret injection is preferable.

## Sizing connection pools

`database.pool.max` limits the administrative pool and each individual query pool. `database.pool.maxGlobalQueries` is the process-wide cap across query pools. Multiply per-process budgets by the number of replicas and leave PostgreSQL capacity for maintenance, monitoring, migrations, and direct operator access.

Start conservatively. Watch checkout timeouts and database utilization before increasing limits. Raising the gateway limit cannot improve throughput when PostgreSQL CPU, I/O, locks, or `max_connections` are already saturated.

## Multiple processes and replicas

- Use Redis so rate-limit counters are shared.
- Ensure every replica sees consistent API-key metadata. A shared path must support SQLite locking and atomic rename; a local copy that drifts is unsafe.
- Use session affinity for editable queued-transaction workflows because their state is held in one process.
- Give each process a separate audit-log directory, or ship stdout and audit events to a centralized collector.
- Decide whether analytics should be per-process or share a supported local filesystem on the same host.
- Point all replicas at the same administrative PostgreSQL database when they must observe the same durable execution records.

A network filesystem is not automatically safe for SQLite locking or atomic replacement. Validate its semantics before sharing runtime files.

## Reverse proxy behavior

Configure the edge to:

- enforce HTTPS and modern TLS;
- preserve streaming-safe timeouts longer than the gateway's longest supported execution window;
- cap request bodies at an application-appropriate size;
- restrict `/admin` by network or identity-aware access policy;
- forward client address information only from trusted proxy hops;
- avoid automatic retries for SQL-changing requests.

Compression is enabled by the application for responses above its threshold. Avoid redundant compression work at multiple layers.

## Graceful shutdown

The first `SIGINT` or `SIGTERM` stops new HTTP work, gives role cleanup a bounded drain period, closes application resources, and then closes query pools. A second signal forces exit. Configure the service manager's termination grace period to cover in-flight transactions and persistence writes; the route reference documents the current execution deadlines.

During a rolling deployment, remove a process from readiness before signaling it. Remember that uncommitted queued transactions on that process will be lost.

## Backup and restore

Back up `data/data.json` together with PostgreSQL on a schedule appropriate for key changes. Encrypt backups and test restoration in an isolated environment. Logs and analytics have different retention and privacy characteristics and may use separate policies.

After restoring:

1. Confirm filesystem ownership and permissions.
2. Confirm the PostgreSQL server and database identities match stored API-key bindings.
3. Start one gateway process and inspect `/admin/health`.
4. Validate a read-only key before enabling write traffic.
5. Confirm pending role cleanup and execution records behave as expected.

## Upgrades

Read the [changelog](../changelog.md) before every upgrade. Build with `npm ci`, stop or drain old processes that share runtime files, back up persistent state, deploy the new artifact, and verify authenticated health. Pay particular attention to releases that change key scopes, runtime lock formats, PostgreSQL schemas, or execution-record semantics.
