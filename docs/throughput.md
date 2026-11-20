# PostgreSQL gateway throughput

An earlier local run delivered **407.61 successful requests per second** at 8 virtual users (VUs), with **32.75 ms p95** and **0.00% HTTP failures**. It used the starting pool configuration of 2 minimum administrative connections, 20 maximum connections per pool, and 40 query connections globally.

## Local results

Each `benchmark/b1.js` run used a 60-second closed-loop workload against `public.benchmark`. Each iteration selected an indexed read with 80% probability or an indexed update with 20% probability. A successful request had to match exactly one row.

| Pool min / max / global | VUs | Successful requests | Attempted req/s | Successful req/s | HTTP failures | Workload p95 | Threshold result                |
| ----------------------- | --: | ------------------: | --------------: | ---------------: | ------------: | -----------: | ------------------------------- |
| 2 / 20 / 40             |   8 |              24,501 |          407.61 |           407.61 |         0.00% |     32.75 ms | Pass                            |
| 2 / 20 / 40             |  16 |              20,120 |          334.86 |           334.86 |         0.00% |     84.17 ms | Pass                            |
| 2 / 20 / 40             |  32 |              15,790 |        2,630.74 |           262.36 |        90.02% |     72.84 ms | Failed checks and HTTP failures |
| 2 / 50 / 100            |  32 |              21,947 |          364.85 |           364.85 |         0.00% |    129.14 ms | Failed latency                  |

The thresholds require more than 99% of checks to pass, fewer than 1% HTTP failures, and workload p95 below 100 ms. Successful throughput uses passed checks divided by elapsed run time. Setup requests are excluded from the table.

At 32 VUs with the starting pool, fast failures contributed to the 72.84 ms workload p95. The k6 expected-response p95 for that run was 132.44 ms.

## Same-host Ubuntu Docker results

The gateway, Node.js, k6, Redis, and PostgreSQL ran on the same Ubuntu 24.04.5 VM. The VM reported two AMD EPYC 7662 vCPUs and about 1.9 GiB of memory. PostgreSQL and Redis ran in Docker containers. The gateway used a 2 / 50 / 100 administrative minimum, per-query-pool maximum, and global query-connection limit, with two prewarmed query connections.

| VUs | Successful requests | Successful req/s | HTTP failures | Workload p95 | Threshold result |
| --: | ------------------: | ---------------: | ------------: | -----------: | ---------------- |
|   8 |              10,928 |           181.80 |         0.00% |     74.54 ms | Pass |
|  16 |              11,340 |           188.66 |         0.00% |    138.63 ms | Failed latency |

Eight VUs are the measured passing baseline for this shared host. At 16 VUs, throughput grew by only 3.8% while p95 exceeded the 100 ms target. The health endpoint reported no pending checkouts, connection timeouts, or pool-capacity rejections after the run, so the result reflects same-host CPU, memory, and container scheduling pressure rather than pool exhaustion.

For this host, prewarm the baseline worker count and leave enough headroom for PostgreSQL, Redis, Node.js, and k6.

```yaml
database:
  pool:
    min: 2
    queryMin: 8
    max: 16
    maxGlobalQueries: 16
```

Restart the gateway, confirm `GET /admin/health` reports `reserved: 8` and `idle: 8`, and run the baseline against the benchmark database.

```bash
DB_NAME=mydb B1_VUS=8 API_KEY="$API_KEY" k6 run benchmark/b1.js
```

Use 12 and 16 VUs only as saturation checks. The updated arrival profile starts at 25 requests per second and ramps to 200 requests per second, which can be changed with `B1_ARRIVAL_MAX_RATE`.

## Social endurance workload

The one-hour social-media workload uses joins, indexed lookups, multi-row responses, inserts, updates, foreign-key checks, and growing tables. It ramps through 50, 100, and 150 requests per second and targets p95 below 600 ms for the MacBook-to-VPS path. [Runbook and workload details](../benchmark/social.md)

## B3–B6 application workloads

| Script | Workload | Reads | Writes | Normal RPS | Peak RPS |
| --- | --- | ---: | ---: | ---: | ---: |
| [B3](../benchmark/b3.js) | Authentication | 95% | 5% | 75 | 150 |
| [B4](../benchmark/b4.js) | Analytics | 20% | 80% | 50 | 125 |
| [B5](../benchmark/b5.js) | Ticketing system | 85% | 15% | 30 | 100 |
| [B6](../benchmark/b6.js) | Chat application | 65% | 35% | 50 | 150 |

Load the synthetic fixture as an administrator in a dedicated benchmark database. The fixture grants access to `http_postgres_benchmark_crud` by default. Pass `-v query_role=your_role` if the API key's database profile uses a different login.

```bash
psql -X -U myuser -d mydb -f benchmark/workloads.sql
```

Run each rate separately with the same `API_KEY`, `BASE_URL`, and `DB_NAME` settings. Each run schedules one query request per iteration for 60 seconds by default.

```bash
DB_NAME=mydb API_KEY="$API_KEY" k6 run benchmark/b3.js
DB_NAME=mydb API_KEY="$API_KEY" WORKLOAD_LEVEL=peak k6 run benchmark/b3.js
```

Use `WORKLOAD_DURATION`, `WORKLOAD_PRE_ALLOCATED_VUS`, and `WORKLOAD_MAX_VUS` to change the duration and k6 worker allocation. The `workload_reads`, `workload_writes`, `workload_errors`, and `workload_latency` metrics cover requests sent after setup. Check `dropped_iterations` to see whether k6 could sustain the configured rate.

## Reproduce the local starting run

Set `database.pool` to the following values in `gateway.yaml` and restart the local gateway. [Pool configuration](configuration.md#yaml-settings)

```yaml
database:
  pool:
    min: 2
    max: 20
    maxGlobalQueries: 40
```

```bash
B1_VUS=8 API_KEY="$API_KEY" k6 run benchmark/b1.js
```
