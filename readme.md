# HTTP PostgreSQL Gateway

Run PostgreSQL queries over HTTP with database-scoped API keys. The gateway supports immediate queries, queued transactions, and administrative routes for databases, API keys, health, and logs.

## Run locally

Use Node.js 22 or later, npm, and a running PostgreSQL server. The supplied configuration also expects a running Redis server. For local development without Redis, set `redis.enabled` to `false` in `gateway.yaml`.

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL` and, if Redis is enabled, `REDIS_URL` in `.env`. From the project root, start the development server and check that it responds.

```sh
npm run dev
```

```sh
curl http://localhost:8080/health
```

On first startup the gateway prints a generated admin password and saves its hash in `data/data.json`. Save the password for requests to `/admin`. Subsequent startups reuse the saved hash.

## Run a query

Create an API key for an existing database. This example uses the default `postgres` database. Replace `<admin-password>` with the password printed at startup.

```sh
curl -sS http://localhost:8080/admin/keys \
  -H 'x-admin: <admin-password>' \
  -H 'Content-Type: application/json' \
  -d '{"database":"postgres"}'
```

Copy the returned `data.apiKey` into the next request.

```sh
curl -sS http://localhost:8080/query \
  -H 'x-api-key: <api-key>' \
  -H 'x-database: postgres' \
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
