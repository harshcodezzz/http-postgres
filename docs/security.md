# Security

The gateway reduces direct database credential exposure, but it is still a SQL execution service. A secure deployment depends on network isolation, careful PostgreSQL grants, protected secrets, and conservative client retry behavior.

## Trust model

Treat the following as trusted:

- operators who can read or change `gateway.yaml`, environment variables, or runtime files;
- clients holding the administrator password;
- clients holding API keys, within the PostgreSQL scope assigned to those keys;
- the configured PostgreSQL administrator role;
- infrastructure that terminates TLS and forwards client IP information.

API keys are bearer credentials. Anyone who obtains one can use its current scope until the key is revoked.

## Network controls

- Keep PostgreSQL and Redis on private networks and restrict them to gateway hosts.
- Terminate TLS at a reverse proxy or load balancer and use TLS from the proxy to the gateway when the network is not trusted.
- Restrict `/admin` routes by firewall, private ingress, VPN, or a separate internal proxy rule. The administrator password should not be the only control.
- Configure trusted proxy behavior deliberately before relying on source IP for rate limiting. Do not accept spoofable forwarding headers from arbitrary clients.
- Bind `server.host` to `127.0.0.1` when only a local reverse proxy should reach the process.

## PostgreSQL least privilege

The administrative URL is powerful by design. Give its role only the capabilities needed for enabled features:

- connection and ownership rights for the gateway persistence schema;
- `CREATEROLE` and grant rights when the gateway provisions scoped API-key roles;
- database creation, alteration, or deletion privileges only when those admin routes are required;
- session visibility needed to verify and recover query connections.

Scoped query roles must be distinct from administrative roles, have no elevated memberships, and lack access to unrelated databases. PostgreSQL grants `CONNECT` and some schema privileges to `PUBLIC` by default; audit and revoke these where they conflict with intended scopes.

PostgreSQL privileges are additive. A narrow grant created by the gateway cannot cancel a broader grant inherited from `PUBLIC`, another role, a routine, a foreign server, or an extension. Review the complete effective privilege set.

## Credential and file handling

- Store `DATABASE_URL`, `REDIS_URL`, and deployment-specific query URLs in a secret manager rather than source control.
- Protect the first-start administrator password and rotate access if it is exposed.
- Restrict `data/data.sqlite`, its WAL/SHM files, and `data/data.json.backup` to the service account. They contain key metadata and secret material for scoped database roles.
- Protect logs and analytics. Failed SQL can contain identifiers and literals; full SQL storage increases that exposure.
- Never send secrets as SQL literals. Use bound parameters.
- Do not include `.env`, `data/`, `logs/`, or generated backups in container images or repository commits.

## API-key practices

- Issue separate keys for separate services and environments.
- Prefer table-specific scopes and read-only access when writes are unnecessary.
- Store the raw key when it is created; do not log it or place it in URLs.
- Revoke unused keys and permanently delete records only after the associated PostgreSQL role cleanup has succeeded.
- Resave database-wide scopes after schema changes so new tables and sequences receive only the intended privileges.
- Treat `LIVE` and `TEST` as labels, not as independent security boundaries; deploy separate infrastructure for strong environment isolation.

## SQL and retry safety

Parameterized values prevent injection through values, but identifiers and SQL structure cannot be safely parameterized with PostgreSQL placeholders. Construct dynamic SQL from strict allowlists or a trusted SQL builder.

Some failures occur after SQL has been sent. `QUERY_OUTCOME_UNKNOWN` or a transaction status of `unknown` means a write may have committed. Verify application state or use an application-level idempotency design before retrying. Do not build a generic automatic retry around these outcomes.

The gateway rejects streaming `COPY` over JSON routes and applies statement, result, and memory limits. These controls reduce risk; they do not make arbitrary untrusted SQL safe.

## Rate limiting and denial of service

Enable both per-IP and per-key limits. Redis-backed counters are needed for consistent enforcement across replicas. Size PostgreSQL pools and `maxGlobalQueries` below the database's safe connection budget, leaving capacity for administration and recovery.

The public health route is exempt from request limits. Protect it at the edge if public polling could create unwanted load.

## Analytics privacy

With `analytics.storeFullSql: false`, failed SQL is sanitized on a best-effort basis and bound values are omitted. Sanitization is not a data-loss-prevention boundary. Disable analytics or tightly restrict its storage and admin endpoint when query text is sensitive.

## Security review checklist

- [ ] TLS is enforced before credentials cross the network.
- [ ] Admin routes are reachable only from an operator network.
- [ ] PostgreSQL and Redis are not publicly reachable.
- [ ] Public and inherited PostgreSQL privileges have been audited.
- [ ] Runtime files, logs, analytics, and backups have restrictive permissions.
- [ ] Keys are unique per client and use the smallest practical CRUD scope.
- [ ] Rate limits and connection budgets match expected traffic.
- [ ] Clients handle unknown outcomes without unsafe retries.
- [ ] Error detail exposure and full-SQL analytics are disabled unless explicitly required.

If you believe you found a vulnerability, do not open a public issue or disclose exploit details publicly. Follow the repository [security policy](../SECURITY.md) and report it privately to [harsh@1st-services.com](mailto:harsh@1st-services.com).
