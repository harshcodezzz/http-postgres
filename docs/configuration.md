# Configuration

Start the gateway from the project root. It loads `.env` and reads `gateway.yaml` from the working directory. Environment variables set before startup take precedence over `.env`.

YAML string values can reference an environment variable as `${NAME}` or supply a fallback as `${NAME:-fallback}`. A missing variable without a fallback prevents startup. An empty variable counts as set. Substitution produces strings, so use YAML numbers and booleans for numeric and boolean fields.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string referenced by the supplied YAML. The local fallback is `postgresql://postgres:postgres@127.0.0.1:5432/postgres`. |
| `REDIS_URL` | Redis connection string referenced by the supplied YAML. The local fallback is `redis://127.0.0.1:6379`. |
| `LOG_LEVEL` | Pino level for gateway logging. Defaults to `info`. The stdout and file transport targets are configured at `info`. |

## YAML settings

The table lists loader defaults. Explicit values in [gateway.yaml](../gateway.yaml) take precedence.

| Setting | Default | Behavior |
| --- | --- | --- |
| `version` | Required | Positive integer. The supplied file uses `1`. |
| `server.host` | `0.0.0.0` | Listen address. Use `127.0.0.1` for loopback-only access. |
| `server.port` | `8080` | Listen port from 1 to 65535. |
| `database.url` | Required | Administrative PostgreSQL connection string. The gateway checks it at startup. |
| `database.exposeErrorDetails` | `false` | Exposes PostgreSQL detail and hint text to authenticated query callers when enabled. |
| `database.queryUrls` | `{}` | Maps database names to the default query login URLs used by keys that list database names only. |
| `database.queryProfiles` | `{}` | Maps database names to PostgreSQL logins for explicit API-key privilege sets. |
| `database.pool.min` | `2` | Minimum size of the administrative pool, zero or greater. |
| `database.pool.max` | `20` | Maximum size of the administrative pool and of each query pool. A database has a separate pool for its default login and each configured privilege profile. The minimum cannot exceed the maximum. |
| `database.pool.maxGlobalQueries` | `40` | Process-wide query connection budget across all databases and profiles. Includes connections being opened or closed and excludes the administrative pool. A full per-profile pool rejects new requests before they consume global slots. |
| `redis.enabled` | `true` | Connect to Redis on startup. Set to `false` to use an in-memory store local to the gateway process. |
| `redis.mode` | `external` | Accepts `external` or `managed`. Both currently connect to the configured Redis URL when enabled. |
| `redis.url` | Required when enabled | Redis connection string. |
| `ratelimit.enabled` | `true` | Enable the per-IP and per-key request limits. |
| `ratelimit.requestPerMinute` | `1000` | Requests per authenticated API key in a 60-second window. |
| `ratelimit.requestPerMinutePerIp` | `1000` | Requests per IP in a 60-second window. Applies before authentication. |
| `ratelimit.whitelistedIPs` | `[]` | Exact client IP strings exempt from the per-IP limit. Replace the example placeholders in the supplied file with real addresses or `[]`. |
| `analytics.enabled` | `true` | Accepted by the configuration loader. Analytics collection is unimplemented. |
| `analytics.directory` | `./data/analytics` | Configured path for analytics. |

For a loopback-only development instance without Redis, set these fields in the existing YAML file.

```yaml
server:
  host: "127.0.0.1"
  port: 8080
redis:
  enabled: false
```

## Query database access

Configure a dedicated PostgreSQL login for each default connection or privilege profile. Give the login `CONNECT` on its database and the schema and object privileges needed by the queries. The gateway checks that the login is separate from the administrative roles, has no elevated role memberships, and lacks `CONNECT` on other connectable databases. PostgreSQL grants `CONNECT` to `PUBLIC` by default. On a shared cluster, grant access explicitly to the roles that need each database before revoking the public grant. Keep cross-database connections, foreign servers, and privileged routines out of the query login's grants. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

Use a direct PostgreSQL connection or a session-mode proxy that resets each backend session on client disconnect. The admin and query URLs must point to the same PostgreSQL cluster. Provide the full URL for each database, including its database name. Store credentials in environment variables and reference them from YAML.

```yaml
database:
  url: "${DATABASE_URL}"
  queryUrls:
    gateway_demo: "${QUERY_DEMO_URL}"
```

For explicit API-key privileges, define each supported set in `queryProfiles`. The URL's PostgreSQL login must match `role`, and each profile on a database must have a distinct role and privilege set.

```yaml
database:
  queryProfiles:
    sales:
      - scopes: [SELECT]
        role: sales_reader
        url: "${SALES_READER_URL}"
    events:
      - scopes: [SELECT, INSERT]
        role: events_writer
        url: "${EVENTS_WRITER_URL}"
```

Provision the PostgreSQL grants before using a profile. For example, grant `sales_reader` `CONNECT` on `sales`, `USAGE` on the needed schema, and `SELECT` on the intended tables. PostgreSQL also honors permissions inherited from other roles or granted to `PUBLIC`, plus permissions exposed through views and routines. Review those paths when provisioning a login. The profile selects the login, and its PostgreSQL grants determine access to individual objects. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

When renaming a served database, configure the destination name and connection URLs and restart the gateway. Record IDs and secrets of older API keys can be preserved by resaving their verified database scopes through the admin API. See the [upgrade procedure](fixes.md#upgrade-procedure).

## Runtime files

| Path | Contents |
| --- | --- |
| `data/data.json` | Local JsonDB file with the admin password hash and API key records. Keep this file to retain credentials across restarts. |
| `logs/gateway.*.log` | Gateway logs, rotated daily or at the configured `20m` size threshold. |
| `logs/current.log` | Symlink to the active gateway log. |
| `logs/api-keys.log` | Active API key audit events. Rotates at 5 MiB. |
| `logs/api-keys.log.1` | Previous audit log generation. |

Fastify's request completion logs print `responseTime` in milliseconds as a JSON string with three decimal places. Processes sharing JsonDB must use the same data path on a filesystem that supports atomic directory creation and rename. Writers wait up to five seconds for the adjacent `data.json.lock` directory. If a process dies while holding the lock, remove the lock directory only after confirming all gateway processes using the file have stopped. Use a separate audit-log directory per process. Transaction queues are held in process memory and have no runtime file.
