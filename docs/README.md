# Documentation

This directory documents how to connect HTTP-only serverless and edge workloads to PostgreSQL through a persistent gateway, and how to operate that gateway safely.

## Choose a path

### I want to try the gateway

1. Follow [Getting started](getting-started.md).
2. Read the [API routes](routes.md) for supported execution modes.
3. Use [Configuration](configuration.md) to adapt the local setup.

### I want to deploy it

1. Review the [Architecture](architecture.md) to understand state ownership.
2. Apply the [Security](security.md) hardening guidance.
3. Work through the [Deployment](deployment.md) checklist.
4. Keep [Configuration](configuration.md) available as the setting reference.

### I want to integrate a client

1. Start with [Serverless integration](serverless.md) for a `fetch()` example and deployment-specific concerns.
2. Read authentication and execution behavior in [API routes](routes.md).
3. Import [`openapi.yaml`](../openapi.yaml) or [`openapi.json`](../openapi.json) into your API tooling.
4. Pay special attention to outcome-unknown errors before implementing automatic retries.

### I want to contribute

1. Read [Development](development.md).
2. Review [Architecture](architecture.md) before changing storage, authentication, or execution paths.
3. Update the [changelog](../changelog.md) and public documentation with user-visible changes.

## Reference map

| Document | Audience | Purpose |
| --- | --- | --- |
| [Getting started](getting-started.md) | New users | Go from a clean checkout to the first authenticated query |
| [Serverless integration](serverless.md) | Serverless developers | Call PostgreSQL through `fetch()` and handle secrets, timeouts, and retries |
| [Configuration](configuration.md) | Operators | Complete environment and YAML reference, pool behavior, and runtime files |
| [API routes](routes.md) | Client developers | Request and response contracts, transactions, administration, and errors |
| [Architecture](architecture.md) | Operators and contributors | Component boundaries, state stores, and request lifecycles |
| [Security](security.md) | Security reviewers and operators | Trust boundaries, PostgreSQL privileges, secrets, and hardening |
| [Deployment](deployment.md) | Operators | Production topology, persistence, scaling, monitoring, backup, and upgrades |
| [Development](development.md) | Contributors | Source layout, commands, change workflow, and documentation expectations |

## API specifications

The repository includes OpenAPI descriptions in both [YAML](../openapi.yaml) and [JSON](../openapi.json). Keep both files synchronized with route behavior. The prose route guide remains the source for operational semantics that do not fit cleanly into an API schema, including retry safety and transaction outcome handling.
