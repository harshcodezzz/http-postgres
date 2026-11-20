# PostgreSQL gateway throughput

The fastest passing local run delivered **407.61 successful requests per second** at 8 virtual users (VUs), with **32.75 ms p95** and **0.00% HTTP failures**. It used the starting pool configuration of 2 minimum administrative connections, 20 maximum connections per pool, and 40 query connections globally.

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
