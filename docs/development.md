# Development and contributing

Contributions should keep the gateway's security boundaries, persistent formats, API descriptions, and operator documentation aligned.

## Local setup

```sh
npm ci
cp .env.example .env
npm run dev
```

Provide PostgreSQL and Redis as described in [Getting started](getting-started.md). Redis may be disabled in `gateway.yaml` for a single-process development environment.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript entry point with file watching |
| `npm run build` | Type-check and compile `src/` into `dist/` |
| `npm start` | Run the compiled `dist/index.js` application |

The repository currently has no automated test command. At minimum, run `npm run build` and manually exercise the affected route against a disposable PostgreSQL database before proposing a change.

## Repository layout

```text
src/
  config/       configuration loading and query-privilege definitions
  middleware/   authentication and rate limiting
  plugins/      Fastify infrastructure and error handling
  routes/       admin, query, and transaction HTTP routes
  utils/        PostgreSQL pools, API keys, policy, analytics, and bootstrap
docs/           operator and contributor documentation
gateway.yaml    runtime configuration
openapi.yaml    machine-readable API contract
openapi.json    JSON form of the API contract
```

`src/index.ts` owns process startup and shutdown. `src/app.ts` assembles Fastify. Route registration in `src/routes/index.ts` wires persistent execution storage, analytics, and query pools into the route groups.

## Change workflow

1. Start from a focused issue or clearly described behavior change.
2. Inspect the affected route, middleware, storage, and shutdown paths before editing.
3. Preserve backward compatibility unless the change is intentionally breaking and documented.
4. Run `npm run build`.
5. Exercise success, authentication failure, permission failure, limit handling, and shutdown behavior relevant to the change.
6. Update both OpenAPI files when the HTTP contract changes.
7. Update the relevant guide and add a concise changelog entry for user-visible behavior.

## Design principles

- Let PostgreSQL enforce database privileges; application checks should not pretend to replace database authorization.
- Fail closed when database identity, connection ownership, or execution outcome cannot be verified.
- Bound queues, connections, memory, result sizes, and background work.
- Never expose database credentials, raw API keys, password hashes, backend secret keys, or bound SQL values in logs.
- Preserve precision by default and make lossy conversion explicit.
- Treat shutdown and partial failure as part of the feature, especially around `COMMIT`.
- Keep process-local and durable state clearly distinguishable in APIs and documentation.

## API documentation changes

When a route changes, check all of the following:

- method, path, headers, query parameters, request body, and response schema;
- authentication and authorization requirements;
- HTTP status and stable error code;
- idempotency and retry behavior;
- execution deadlines, size limits, and retention;
- examples in `readme.md`, `docs/routes.md`, `openapi.yaml`, and `openapi.json`.

The OpenAPI YAML and JSON files are two representations of the same public contract. Avoid editing only one.

## Review guidance

Security-sensitive changes deserve particular attention when they touch:

- admin password verification or API-key comparison;
- PostgreSQL role creation, grants, cleanup, or database identity binding;
- SQL policy, read-only enforcement, session reset, or connection reuse;
- transaction commit confirmation and unknown outcomes;
- secret-bearing errors and logs;
- SQLite metadata migrations, transactions, role scheduling, analytics worker recovery, or retention.

## Pull request expectations

Keep changes narrowly scoped and explain the operational effect. Include manual verification steps and call out any migration, compatibility, security, or rollback consideration. Do not commit local `.env` files, runtime data, logs, compiled output, or credentials.

Contributions are accepted under the repository's [MIT License](../LICENSE). Suspected vulnerabilities should follow the repository [security policy](../SECURITY.md) instead of the normal public contribution workflow.
