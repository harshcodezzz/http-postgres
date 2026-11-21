# HTTP PostgreSQL Gateway

Run PostgreSQL queries over HTTP with database and table-scoped API keys. The gateway supports immediate and asynchronous queries, queued transactions, and administrative routes for databases, API keys, health, and logs.

## Run locally

Use Node.js 22.13+ on the 22.x line or Node.js 23.4+, with npm and a running PostgreSQL server. The supplied configuration also expects a running Redis server. For local development without Redis, set `redis.enabled` to `false` in `gateway.yaml`.

The gateway checks the Node.js version and built-in SQLite module at startup. Use a Node.js build with `node:sqlite` enabled for the JsonDB lock.

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL` and, if Redis is enabled, `REDIS_URL` in `.env`. Use a PostgreSQL administrator connection in `DATABASE_URL` to manage databases and issue CRUD-scoped keys.

```sh
npm run dev
```

```sh
curl http://localhost:8080/health
```

On first startup the gateway prints a generated admin password and saves its hash in `data/data.json`. Save the password for requests to `/admin`. Subsequent startups reuse the saved hash.

## Run a query

On a disposable PostgreSQL cluster, run these commands as the cluster administrator.

```sql
CREATE DATABASE gateway_demo;
REVOKE CONNECT ON DATABASE postgres, template1, gateway_demo FROM PUBLIC;
\connect gateway_demo
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE public.messages (message text);
INSERT INTO public.messages VALUES ('hello');
```

Create a key with read access to the `public.messages` table. Replace `<admin-password>` with the password printed at startup.

```sh
curl -sS http://localhost:8080/admin/keys \
  -H 'x-admin: <admin-password>' \
  -H 'Content-Type: application/json' \
  -d '{"database":["gateway_demo"],"tables":["public.messages"],"scope-table":["r"]}'
```

Copy the returned `data.apiKey` into the next request.

```sh
curl -sS http://localhost:8080/query \
  -H 'x-api-key: <api-key>' \
  -H 'x-database: gateway_demo' \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT message FROM public.messages"}'
```

## Build and start

```sh
npm run build
npm start
```

- [Routes and transaction workflow](docs/routes.md)
- [Configuration and runtime files](docs/configuration.md)
