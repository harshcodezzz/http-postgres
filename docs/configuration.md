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
| `database.url` | Required | PostgreSQL connection string. The gateway checks that it can connect at startup. |
| `database.pool.min` | `2` | Minimum pool size, zero or greater. |
| `database.pool.max` | `20` | Maximum pool size, at least 1. The minimum cannot exceed the maximum. |
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

## Runtime files

| Path | Contents |
| --- | --- |
| `data/data.json` | Local JsonDB file with the admin password hash and API key records. Keep this file to retain credentials across restarts. |
| `logs/gateway.*.log` | Gateway logs, rotated daily or at the configured `20m` size threshold. |
| `logs/current.log` | Symlink to the active gateway log. |
| `logs/api-keys.log` | API key audit events. |

Fastify's request completion logs print `responseTime` in milliseconds as a JSON string with three decimal places. Transaction queues are held in process memory and have no runtime file.
