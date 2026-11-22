# Getting started

This guide starts a local gateway, prepares an isolated PostgreSQL database, creates a least-privilege API key, and runs a query.

## 1. Check prerequisites

You need:

- Node.js `22.13+` on the 22.x line, or Node.js `23.4+`, with `node:sqlite` enabled
- npm
- a PostgreSQL server you can administer
- Redis, unless you disable it for local development

Verify Node.js before installing dependencies:

```sh
node --version
node -e "import('node:sqlite').then(() => console.log('node:sqlite available'))"
```

## 2. Install and configure

From the repository root:

```sh
npm ci
cp .env.example .env
```

Set the PostgreSQL administrator URL in `.env`:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
REDIS_URL=redis://127.0.0.1:6379
```

The administrator connection is used for health checks, durable execution records, database administration, and provisioning the restricted PostgreSQL roles behind scoped API keys. For local development without Redis, change the existing `gateway.yaml`:

```yaml
redis:
  enabled: false
```

The fallback store is in memory and is appropriate only when process-local rate-limit state is acceptable.

## 3. Prepare a disposable database

Run the following as a PostgreSQL administrator. Do this only on a development cluster where changing public privileges is safe:

```sql
CREATE DATABASE gateway_demo;
REVOKE CONNECT ON DATABASE postgres, template1, gateway_demo FROM PUBLIC;
GRANT CONNECT ON DATABASE gateway_demo TO postgres;

\connect gateway_demo
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message text NOT NULL
);

INSERT INTO public.messages (message) VALUES ('hello from PostgreSQL');
```

Revoking public access is important because PostgreSQL privileges are additive. The gateway refuses to represent a narrow scope when broader grants make that scope unsafe.

## 4. Start the gateway

```sh
npm run dev
```

On the first startup, the process generates and prints an administrator password. Save it in a password manager. The gateway stores only a password hash and does not print the same secret again.

In another terminal, check the public liveness endpoint:

```sh
curl --fail-with-body http://localhost:8080/health
```

Expected response:

```json
{"status":"ok"}
```

## 5. Create a scoped API key

Replace `<admin-password>` with the value printed at first startup:

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

Store `data.apiKey` from the response immediately. Later list operations return metadata, not the original secret.

CRUD scope letters are `c` for insert, `r` for select, `u` for update, and `d` for delete. See [API-key database and table scopes](routes.md#api-key-database-and-table-scopes) before issuing write credentials.

## 6. Run the first query

```sh
curl --fail-with-body http://localhost:8080/query \
  -H 'x-api-key: <api-key>' \
  -H 'x-database: gateway_demo' \
  -H 'content-type: application/json' \
  -d '{"query":"SELECT id, message FROM public.messages WHERE id = $1","parameters":[1]}'
```

Use placeholders and `parameters` for untrusted values. Parameterization protects values from being interpreted as SQL and keeps them out of the SQL text recorded for failed-query analytics.

## 7. Inspect dependency health

The public endpoint proves only that HTTP routing is alive. Use the authenticated endpoint for operational checks:

```sh
curl --fail-with-body http://localhost:8080/admin/health \
  -H 'x-admin: <admin-password>'
```

It reports PostgreSQL, key-value storage, local metadata, and query-connection capacity.

## Next steps

- Explore immediate, async, batch, and queued execution in [API routes](routes.md).
- Review every setting in [Configuration](configuration.md).
- Read [Security](security.md) before exposing the service outside a development machine.
- Use the [Deployment](deployment.md) checklist for a persistent environment.

## Troubleshooting startup

| Symptom | Check |
| --- | --- |
| Node.js or SQLite requirement error | Use a supported Node.js build with `node:sqlite` enabled. |
| `Failed to connect to PostgreSQL` | Verify `DATABASE_URL`, credentials, network access, and TLS parameters required by your server. |
| Redis connection failure | Start Redis, correct `REDIS_URL`, or set `redis.enabled: false` for local work. |
| Missing environment variable | Define the referenced variable or use an explicit `${NAME:-fallback}` in `gateway.yaml`. |
| Scoped-key creation is rejected | Remove broader PostgreSQL grants and confirm the admin role can create and grant roles. |
