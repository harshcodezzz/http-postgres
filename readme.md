# HTTP PostgreSQL Gateway

Use PostgreSQL from serverless and edge runtimes over ordinary HTTP—without opening a TCP connection, shipping a native database driver, or relying on Unix sockets.

HTTP PostgreSQL Gateway is a self-hosted bridge that runs close to PostgreSQL and exposes scoped query and transaction APIs to environments that can call `fetch()` but cannot connect to PostgreSQL directly.

> [!IMPORTANT]
> This project executes SQL supplied by authenticated clients. Treat it as privileged infrastructure: deploy it on a trusted network, use TLS at the edge, and grant every API key only the PostgreSQL privileges it needs.

## PostgreSQL for HTTP-only runtimes

Many serverless, edge, browser-like, workflow, and sandboxed runtimes allow outbound HTTPS but do not support PostgreSQL's long-lived TCP protocol or local Unix sockets. Even where raw sockets exist, short-lived invocations can make connection setup and pool management inefficient.

Run the gateway as persistent infrastructure on the same private network as PostgreSQL. Serverless clients send authenticated HTTPS requests; the gateway owns PostgreSQL connections and reuses them safely.

```text
Serverless / edge function
        |
        | HTTPS + API key
        v
HTTP PostgreSQL Gateway
        |
        | pooled TCP or Unix-socket connections
        v
    PostgreSQL
```

- **Works with `fetch()`** — callers need only standard JSON-over-HTTP support, not `pg`, libpq, native modules, raw sockets, or a persistent process.
- **Connection pooling outside the function** — keep PostgreSQL sessions in a long-running gateway instead of creating a new connection for every cold start or invocation.
- **Scoped credentials** — issue revocable API keys restricted to databases, tables, and CRUD operations.
- **PostgreSQL-enforced access** — scoped keys run through dedicated PostgreSQL login roles rather than relying only on application checks.
- **Flexible execution** — run immediate queries, persistent asynchronous queries, atomic batches, or editable queued transactions.
- **Operational safeguards** — rate limits, query deadlines, bounded results, global connection budgets, analytics, audit logs, and graceful shutdown.
- **Lossless results** — preserve precision-sensitive PostgreSQL values as text, with an opt-in legacy conversion mode.
- **Self-hosted state** — use PostgreSQL for durable execution records, a local JSON store for key metadata, SQLite for analytics, and optional Redis for distributed rate limits.

## Good fit

- Edge functions without raw TCP socket support
- Serverless functions where a database driver or connection pool is impractical
- Sandboxed jobs, workflow engines, low-code tools, and automation platforms that support webhooks or HTTP actions
- Services that need centrally managed, revocable PostgreSQL access without distributing database passwords

This is not an ORM, a PostgreSQL wire-protocol proxy, or a replacement for direct connections in a conventional long-running backend. If an application already runs beside PostgreSQL and can manage a native pool safely, a direct driver will usually be simpler and faster.

## Gateway requirements

- Node.js `22.13+` on the 22.x line, or Node.js `23.4+`, with `node:sqlite` enabled
- PostgreSQL
- Redis when `redis.enabled` is `true` (the default)

The serverless caller only needs outbound HTTPS and support for JSON requests.

## Quick start

Clone the repository, install the locked dependencies, and create a local environment file:

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL` in `.env`. Either set `REDIS_URL` as well or disable Redis in `gateway.yaml` for a single-process development instance:

```yaml
redis:
  enabled: false
```

Start the development server:

```sh
npm run dev
```

The first startup prints a generated administrator password. Store it securely; only its hash is retained in `data/data.json`.

Confirm that the process is accepting requests:

```sh
curl http://localhost:8080/health
```

For the complete database preparation and first-query walkthrough, see [Getting started](docs/getting-started.md).

## Example

Create an API key with read access to `public.messages` in `gateway_demo`:

```sh
curl --fail-with-body http://localhost:8080/admin/keys \
  -H 'x-admin: <admin-password>' \
  -H 'content-type: application/json' \
  -d '{
    "database": ["gateway_demo"],
    "tables": ["public.messages"],
    "scope-table": ["r"]
  }'
```

Copy `data.apiKey` from the response and run a parameterized query:

```sh
curl --fail-with-body http://localhost:8080/query \
  -H 'x-api-key: <api-key>' \
  -H 'x-database: gateway_demo' \
  -H 'content-type: application/json' \
  -d '{"query":"SELECT message FROM public.messages WHERE id = $1","parameters":[1]}'
```

API keys can also be sent as the raw `Authorization` value. Do not add a `Bearer` prefix.

### Call it from a serverless function

The same API works in serverless runtimes with a standards-compatible `fetch()`. This Node-style example uses environment variables; adapt secret access to your platform:

```ts
export async function getMessage(id: number) {
  const response = await fetch(`${process.env.PG_GATEWAY_URL}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.PG_GATEWAY_API_KEY!,
      "x-database": "gateway_demo",
    },
    body: JSON.stringify({
      query: "SELECT id, message FROM public.messages WHERE id = $1",
      parameters: [id],
    }),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(`Gateway request failed: ${response.status}`);
  return payload;
}
```

Store the gateway URL and API key in the platform's secret manager. Never embed a gateway key in public browser code. See [Serverless integration](docs/serverless.md) for timeouts, retries, credential handling, and execution-mode guidance.

## Execution modes

| Mode | Endpoint | Best for |
| --- | --- | --- |
| Immediate query | `POST /query` | Interactive reads and short operations that need an immediate response |
| Asynchronous query | `POST /query` with `type: "async"` | Longer work that should be polled by ID |
| Atomic batch | `POST /transaction/execute` | A complete set of statements submitted together and committed atomically |
| Queued transaction | `POST /transaction`, then `/transaction/add` | Building and editing a transaction incrementally before commit |

See [Routes and API behavior](docs/routes.md) for request formats, response semantics, limits, status polling, administration endpoints, and error codes. Machine-readable contracts are available as [OpenAPI YAML](openapi.yaml) and [OpenAPI JSON](openapi.json).

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Reading paths and the complete documentation map |
| [Getting started](docs/getting-started.md) | Local setup, PostgreSQL preparation, API-key creation, and a first query |
| [Serverless integration](docs/serverless.md) | `fetch()` usage, credentials, timeouts, retries, and execution-mode selection |
| [Configuration](docs/configuration.md) | Environment variables, YAML settings, connection pools, and runtime files |
| [API routes](docs/routes.md) | Queries, transactions, administration, authentication, errors, and limits |
| [Architecture](docs/architecture.md) | Components, request flow, state ownership, and execution lifecycle |
| [Security](docs/security.md) | Trust model, least-privilege setup, secrets, network controls, and hardening |
| [Deployment](docs/deployment.md) | Production checklist, persistence, scaling, health checks, backup, and shutdown |
| [Development](docs/development.md) | Repository layout, commands, coding workflow, and contribution guidance |
| [Changelog](changelog.md) | Release history and notable behavior changes |

## Configuration at a glance

Runtime configuration lives in `gateway.yaml`. Strings may reference environment variables with `${NAME}` or `${NAME:-fallback}`.

```yaml
version: 1

server:
  host: "0.0.0.0"
  port: 8080

database:
  url: "${DATABASE_URL}"
  queryUrls: {}
  pool:
    min: 2
    queryMin: 1
    max: 20
    maxGlobalQueries: 40
    connectionTimeoutMillis: 10000
    checkoutTimeoutMillis: 10000
    growthIntervalMillis: 0
    maxConcurrentOpenings: 4
    statementTimeoutMillis: 30000
    queryTimeoutMillis: 35000

redis:
  enabled: true
  mode: external
  url: "${REDIS_URL}"
```

Review [Configuration](docs/configuration.md) before changing pool sizes or enabling multiple gateway processes.

## Production notes

- Deploy the gateway as long-running infrastructure near PostgreSQL; do not start a gateway instance inside every serverless invocation.
- Terminate TLS at a trusted reverse proxy or load balancer; the server does not configure HTTPS itself.
- Do not expose administrator routes to the public internet. Apply network controls in addition to the `x-admin` credential.
- Persist and back up `data/data.json`. Losing it loses API-key metadata and the secret used for scoped PostgreSQL roles.
- Use Redis for consistent rate limits across processes. The in-memory store is process-local.
- Queued, uncommitted transactions are process-local and disappear on restart. Async queries and submitted transaction batches use PostgreSQL-backed records.
- Poll `GET /admin/health`, not only public `GET /health`, to assess dependencies and query capacity.

The full operational checklist is in [Deployment](docs/deployment.md).

## Development

```sh
npm run dev      # run with file watching
npm run build    # compile TypeScript into dist/
npm start        # run the compiled application
```

Contributions should keep the OpenAPI descriptions and relevant guides in sync with behavior changes. See [Development and contributing](docs/development.md).

## Project status

The gateway is under active development. Review the [changelog](changelog.md) before upgrading, especially when a release changes persisted execution records, API-key scopes, or PostgreSQL role behavior.

## Security

Do not open a public issue for suspected vulnerabilities. Follow the [security policy](SECURITY.md) and report them privately to [harsh@1st-services.com](mailto:harsh@1st-services.com).

## License

This project is available under the [MIT License](LICENSE).
