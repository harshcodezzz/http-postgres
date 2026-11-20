# HTTP PostgreSQL Gateway

Run PostgreSQL queries over HTTP with database-scoped API keys. The gateway supports immediate queries, queued transactions, and administrative routes for databases, API keys, health, and logs.

## Run locally

Use Node.js 22.13+ on the 22.x line or Node.js 23.4+, with npm and a running PostgreSQL server. The supplied configuration also expects a running Redis server. For local development without Redis, set `redis.enabled` to `false` in `gateway.yaml`.

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL` and, if Redis is enabled, `REDIS_URL` in `.env`. The default configuration starts the admin and health routes. Add query credentials for each database you want to serve before running the query example.

```sh
npm run dev
```

```sh
curl http://localhost:8080/health
```

On first startup the gateway prints a generated admin password and saves its hash in `data/data.json`. Save the password for requests to `/admin`. Subsequent startups reuse the saved hash.

## Run a query

For this example, provision a database and a dedicated login on a disposable local PostgreSQL cluster. Run these commands as the cluster administrator in `psql`.

```sql
CREATE DATABASE gateway_demo WITH ALLOW_CONNECTIONS false;
CREATE ROLE gateway_query LOGIN;
\password gateway_query
REVOKE CONNECT ON DATABASE postgres, template1, gateway_demo FROM PUBLIC;
GRANT CONNECT ON DATABASE gateway_demo TO gateway_query;
ALTER DATABASE gateway_demo WITH ALLOW_CONNECTIONS true;
```

Set `QUERY_DEMO_URL` in `.env` to `postgresql://gateway_query:<encoded-password>@127.0.0.1:5432/gateway_demo`. Add the following mapping to the existing `database` section of `gateway.yaml` and restart the gateway.

```yaml
queryUrls:
  gateway_demo: "${QUERY_DEMO_URL}"
```

Create an API key for `gateway_demo`. Replace `<admin-password>` with the password printed at startup.

```sh
curl -sS http://localhost:8080/admin/keys \
  -H 'x-admin: <admin-password>' \
  -H 'Content-Type: application/json' \
  -d '{"database":"gateway_demo"}'
```

Copy the returned `data.apiKey` into the next request.

```sh
curl -sS http://localhost:8080/query \
  -H 'x-api-key: <api-key>' \
  -H 'x-database: gateway_demo' \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT $1::text AS message","parameters":["hello"]}'
```

## Build and start

```sh
npm run build
npm start
```

- [Routes and transaction workflow](docs/routes.md)
- [Configuration and runtime files](docs/configuration.md)
