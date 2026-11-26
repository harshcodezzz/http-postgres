# HTTP PostgreSQL Gateway

Use PostgreSQL from serverless and edge runtimes over ordinary HTTP—without opening long-lived TCP connections, shipping native database drivers, or relying on Unix sockets.

HTTP PostgreSQL Gateway is a self-hosted bridge that runs close to PostgreSQL and exposes scoped query and transaction APIs to environments that can call `fetch()` but cannot connect to PostgreSQL directly.

> [!IMPORTANT]
> This project executes SQL supplied by authenticated clients. Treat it as privileged infrastructure: deploy it on a trusted network, terminate TLS at the edge, and grant every API key only the PostgreSQL privileges it needs.

## Why HTTP PostgreSQL Gateway?

Many serverless, edge, browser-like, workflow, and sandboxed runtimes allow outbound HTTPS but do not support PostgreSQL's long-lived TCP protocol or local Unix sockets. Even where raw sockets exist, short-lived invocations make per-invocation connection setup and pool management inefficient.

```text
Serverless / Edge Runtime
        |
        | HTTPS + API key
        v
HTTP PostgreSQL Gateway (persistent service)
        |
        | pooled TCP or Unix-socket connections
        v
    PostgreSQL
```

- **Built for `fetch()`** — Callers need only standard JSON over HTTP; no native `pg` modules, libpq, or raw sockets required.
- **Persistent connection pooling** — Keeps PostgreSQL sessions warm and managed in the gateway instead of reconnecting on every cold start or invocation.
- **PostgreSQL-enforced security** — Scoped API keys map to dedicated PostgreSQL roles with granular database- and table-level CRUD permissions.
- **Flexible execution modes** — Supports immediate queries, background asynchronous queries, atomic multi-statement batches, and staged queued transactions.
- **Operational safeguards** — Adaptive connection growth, rate limiting, execution timeouts, bounded result buffers, query analytics, and graceful shutdown.
- **Transactional metadata** — Versioned SQLite metadata with indexed key verification, WAL concurrency, automatic legacy JSON migration, and persistent role-maintenance recovery.

---

## Documentation

Comprehensive guides and references are organized in the [`docs/`](docs/) directory:

| Guide                                                 | Description                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Getting Started](docs/getting-started.md)**        | Prerequisites, local setup, PostgreSQL preparation, creating an API key, and running your first query.                                                |
| **[Serverless Integration](docs/serverless.md)**      | How to use `fetch()`, manage secrets, handle timeouts, configure retries, and integrate with edge platforms.                                          |
| **[API Routes & Specifications](docs/routes.md)**     | Complete reference for query, transaction, and admin endpoints, response contracts, errors, and [OpenAPI specs](openapi.yaml) ([JSON](openapi.json)). |
| **[Configuration Guide](docs/configuration.md)**      | Environment variables, complete `gateway.yaml` settings, connection pool tuning, and runtime storage.                                                 |
| **[Architecture](docs/architecture.md)**              | Internal system architecture, connection pool lifecycle, state isolation, and background workers.                                                     |
| **[Security Guide](docs/security.md)**                | Threat model, PostgreSQL role generation, network controls, and security hardening.                                                                   |
| **[Deployment Guide](docs/deployment.md)**            | Production topology, scaling, health probes, backup strategies, and operational checklists.                                                           |
| **[Development & Contributing](docs/development.md)** | Project layout, development workflow, TypeScript compilation, and coding guidelines.                                                                  |
| **[Documentation Index](docs/README.md)**             | Guided reading paths tailored for evaluators, client developers, operators, and contributors.                                                         |
| **[Changelog](changelog.md)**                         | Release notes, breaking changes, and migration details.                                                                                               |

---

## Quick Start

1. **Clone and install dependencies:**

   ```sh
   npm ci
   cp .env.example .env
   ```

2. **Configure your database URL** in `.env` (and optionally configure Redis in `gateway.yaml` or `.env`).

3. **Start the gateway:**

   ```sh
   npm run dev
   ```

   _The initial startup prints an auto-generated administrator password. Save this password to manage keys and databases._

4. **Verify health:**
   ```sh
   curl http://localhost:8080/health/ready
   ```

Follow the complete step-by-step walkthrough in **[Getting started](docs/getting-started.md)** to provision your first database, generate scoped API keys, and execute queries.

---

## Quick Example

Query PostgreSQL from any runtime supporting `fetch()`:

For a ready-to-use TypeScript client, install the [`@http-postgres/sdk`](https://www.npmjs.com/package/@http-postgres/sdk) package.

```ts
const response = await fetch(`${process.env.PG_GATEWAY_URL}/query`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.PG_GATEWAY_API_KEY!,
    "x-database": "my_database",
  },
  body: JSON.stringify({
    query: "SELECT id, name FROM users WHERE id = $1",
    parameters: [42],
  }),
});

const result = await response.json();
```

For complete request formats, async query polling, atomic batches, and queued transactions, see **[Serverless integration](docs/serverless.md)** and **[API routes](docs/routes.md)**.

---

## Security

Please do not open public issues for security vulnerabilities. Follow the [Security Policy](SECURITY.md) and report issues privately to [harsh@1st-services.com](mailto:harsh@1st-services.com).

## License

This project is available under the [MIT License](LICENSE).
