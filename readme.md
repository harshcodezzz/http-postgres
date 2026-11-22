# HTTP PostgreSQL Gateway

Expose PostgreSQL through a small, self-hosted HTTP API with database-aware API keys, table-level CRUD scopes, synchronous and asynchronous execution, and transaction workflows.

> [!IMPORTANT]
> This project executes SQL supplied by authenticated clients. Treat it as privileged infrastructure: deploy it on a trusted network, use TLS at the edge, and grant every API key only the PostgreSQL privileges it needs.

## Why HTTP PostgreSQL Gateway?

The gateway is useful when an application or automation client needs controlled PostgreSQL access but cannot—or should not—hold a direct database connection.

- **Scoped credentials** — issue revocable API keys restricted to databases, tables, and CRUD operations.
- **PostgreSQL-enforced access** — scoped keys run through dedicated PostgreSQL login roles rather than relying only on application checks.
- **Flexible execution** — run immediate queries, persistent asynchronous queries, atomic batches, or editable queued transactions.
- **Operational safeguards** — rate limits, query deadlines, bounded results, global connection budgets, analytics, audit logs, and graceful shutdown.
- **Lossless results** — preserve precision-sensitive PostgreSQL values as text, with an opt-in legacy conversion mode.
- **Self-hosted state** — use PostgreSQL for durable execution records, a local JSON store for key metadata, SQLite for analytics, and optional Redis for distributed rate limits.

## Requirements

- Node.js `22.13+` on the 22.x line, or Node.js `23.4+`, with `node:sqlite` enabled
- PostgreSQL
- Redis when `redis.enabled` is `true` (the default)

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

## Execution modes

| Mode | Endpoint | Best for |
| --- | --- | --- |
| Immediate query | `POST /query` | Interactive reads and short operations that need an immediate response |
| Asynchronous query | `POST /query` with `type: "async"` | Longer work that should be polled by ID |
| Atomic batch | `POST /transaction/run` | A complete set of statements submitted together and committed atomically |
| Queued transaction | `POST /transaction`, then `/transaction/add` | Building and editing a transaction incrementally before commit |

See [Routes and API behavior](docs/routes.md) for request formats, response semantics, limits, status polling, administration endpoints, and error codes. Machine-readable contracts are available as [OpenAPI YAML](openapi.yaml) and [OpenAPI JSON](openapi.json).

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Reading paths and the complete documentation map |
| [Getting started](docs/getting-started.md) | Local setup, PostgreSQL preparation, API-key creation, and a first query |
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

redis:
  enabled: true
  mode: external
  url: "${REDIS_URL}"
```

Review [Configuration](docs/configuration.md) before changing pool sizes or enabling multiple gateway processes.

## Production notes

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

The npm package metadata currently declares the ISC license. Add a repository-level `LICENSE` file with the appropriate copyright holder before publishing or accepting external contributions.
