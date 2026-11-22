# Serverless integration

HTTP PostgreSQL Gateway is designed for runtimes that support outbound HTTPS but cannot open PostgreSQL TCP connections or Unix sockets. The gateway stays close to PostgreSQL, owns the native connection pools, and gives short-lived callers a JSON API they can use with `fetch()`.

## Deployment model

```text
Serverless or edge runtime
  - no PostgreSQL driver
  - no raw TCP or Unix socket
  - short-lived execution
            |
            | HTTPS
            v
Persistent gateway service
  - authentication and scopes
  - reusable connection pools
  - limits and observability
            |
            | private TCP / Unix socket
            v
         PostgreSQL
```

Deploy the gateway as a long-running service in the PostgreSQL network. Do not package or start it as part of every serverless invocation.

## Minimal `fetch()` client

Use secrets supplied by the serverless platform, not values committed to source control:

```ts
type GatewayQuery = {
  success: boolean;
  data?: {
    rows?: unknown[];
  };
  error?: {
    code: string;
    message: string;
  };
};

export async function queryPostgres(
  sql: string,
  parameters: unknown[] = [],
): Promise<GatewayQuery> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 34_000);

  try {
    const response = await fetch(`${process.env.PG_GATEWAY_URL}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.PG_GATEWAY_API_KEY!,
        "x-database": process.env.PG_GATEWAY_DATABASE!,
      },
      body: JSON.stringify({ query: sql, parameters }),
      signal: controller.signal,
    });

    const payload = (await response.json()) as GatewayQuery;
    if (!response.ok) {
      throw new Error(payload.error?.code ?? `HTTP_${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}
```

The example uses a client deadline shorter than the immediate-query response deadline. Choose a value that also fits the serverless platform's maximum invocation duration and leaves time for your function to handle the response.

## Credential handling

- Store the gateway base URL and API key in the platform's encrypted secret or environment-variable system.
- Issue a separate key for each application and environment.
- Use the smallest database, table, and CRUD scope the function needs.
- Never ship an API key to public browser or mobile code. Invoke the gateway from trusted server-side code.
- Restrict the gateway at the network edge where the platform provides stable egress identity or private networking.
- Rotate or revoke a key when a deployment secret may have leaked.

The API key replaces a distributed PostgreSQL password, but it remains a bearer credential and must be protected accordingly.

## Choose an execution mode

| Serverless workload | Recommended mode | Reason |
| --- | --- | --- |
| Short read or write | Immediate query | One request returns the result directly |
| Work may exceed the invocation window | Async query | Submit quickly, then poll by query ID from another invocation |
| Several statements must commit together | Atomic batch | Submit the complete unit with an idempotency key |
| Human or workflow builds a batch incrementally | Queued transaction | Add and remove statements before commit; requires routing to the same gateway process |

Editable queued transactions are process-local and are usually the least natural fit for stateless serverless callers. Prefer an atomic batch when all statements are known at submission time.

## Timeouts and cancellation

There are several independent deadlines: the serverless invocation, its HTTP client, the reverse proxy, the gateway checkout and execution limits, and PostgreSQL's statement timeout. Configure outer layers so they do not silently retry a request after giving up on its response.

Aborting `fetch()` does not prove that PostgreSQL stopped before changing data. An immediate write may complete after the caller disconnects, and the gateway can return or persist an unknown outcome when commit confirmation is lost.

Use asynchronous execution when the platform has a short request deadline. Submit the work, persist the returned ID in durable application state, and poll `GET /query/:id` from a later invocation.

## Retry rules

Do not retry every failed HTTP request automatically.

- A failure before SQL dispatch may be safe to retry when the returned code explicitly identifies pre-dispatch capacity or validation failure.
- `QUERY_OUTCOME_UNKNOWN` means SQL was sent and may have taken effect. Verify application state before retrying.
- A transaction status of `unknown` means the commit result could not be confirmed. Do not blindly resubmit it.
- For write batches, supply and persist a stable idempotency key as documented in [API routes](routes.md).
- Design application writes around natural unique keys or another application-level idempotency mechanism.

Disable automatic POST retries in reverse proxies, HTTP libraries, and platform integrations unless the retry policy understands these outcomes.

## Connection behavior

The serverless client creates only an HTTPS connection. PostgreSQL connections live in the gateway and can be reused across many invocations. Pools are isolated by database and access identity, bounded per pool, and constrained by a process-wide query-connection budget.

This removes PostgreSQL socket and driver requirements from the function, but it does not remove database capacity limits. Configure rate limits and pool budgets for the peak concurrency of all serverless callers, including cold-start bursts.

## Platform checklist

- [ ] The runtime supports outbound HTTPS and JSON request bodies.
- [ ] The maximum invocation duration fits the chosen execution mode.
- [ ] Gateway URL, API key, and database name come from protected configuration.
- [ ] The key is unavailable to public client-side code.
- [ ] HTTP and platform layers do not automatically retry SQL-changing POST requests.
- [ ] The gateway endpoint uses TLS and admin routes are not publicly accessible.
- [ ] Function concurrency cannot overwhelm the configured rate and connection limits.
- [ ] Async IDs or idempotency keys are stored durably when the workflow depends on them.
- [ ] Unknown outcomes are reconciled through application state rather than blind retries.

See [Architecture](architecture.md) for state ownership, [Security](security.md) for hardening, and [API routes](routes.md) for the complete contract.
