# Routes

The default base URL is `http://localhost:8080`. Send JSON bodies with `Content-Type: application/json`.

| Routes | Authentication |
| --- | --- |
| `GET /health`, `HEAD /health` | Public. `GET` returns `{"status":"ok"}`. |
| `/admin` | Put the admin password in `x-admin`. |
| `/query`, `/transaction` | Send `x-api-key` and `x-database`. The key must be active and scoped to the named database. |

Query and transaction routes also accept the raw key in `Authorization` and the database name in `x-db-name`. Send the raw key without a `Bearer` prefix.

## Immediate queries

`POST /query` and `POST /query/run` run SQL immediately.

```json
{"query":"SELECT $1::integer AS value","parameters":[42]}
```

`query` is required. `parameters` is optional and accepts the alias `params`. A single-statement response includes `database`, `command`, `rowCount`, `rows`, `fields`, and `durationMs`. The `data` field repeats the result metadata and rows. When PostgreSQL returns multiple statement results, the response uses a `results` array ordered by statement.

## Queued transactions

Use the same API key and database for every request in a transaction. Queues live in process memory and are lost on restart. Creating a transaction, adding or removing queries, and reading the queue require no PostgreSQL connection.

| Method and path | Input and response |
| --- | --- |
| `POST /transaction/create` or `POST /transaction` | Returns `201` with `transactionId`. |
| `POST /transaction/add` | Send the `transaction-id` header and a JSON object with `query` and optional `parameters` or `params`. Returns `201` with `transactionId` and `queryId`. |
| `POST /transaction/remove` or `DELETE /transaction/remove` | Send `transaction-id` and the `query-id` header. A JSON body with `queryId` also works in place of that header. The transaction must be pending. |
| `GET /transaction` | Send `transaction-id`, or look up the containing transaction with the `query-id` header or `?queryId=…`. Returns the transaction status and its queued statements and parameters. |
| `DELETE /transaction` | Send `transaction-id`. Deletes the transaction record and its query lookups. Any committed changes remain in PostgreSQL. |

The ID headers also accept `x-transaction-id` and `x-query-id`. Each queue entry is one SQL statement and must begin with a SQL command. Use the gateway's commit operation for transaction control.

1. Create a transaction and copy its `transactionId`.
2. Send each statement to `POST /transaction/add` with the ID in the header. Save the returned `queryId` if you want to remove the statement or look up its transaction.
3. Send `{"query":"COMMIT"}` to the same endpoint with the same header. The gateway runs the entire queue in order on one PostgreSQL connection and returns a `results` array with the `queryId` on each result.

If a statement fails, the gateway rolls back and returns the failing `queryId`. The transaction returns to `pending` so you can remove the statement and retry. If the commit outcome cannot be confirmed, the status becomes `failed` and the API rejects further commit attempts for that transaction.

## Administration

| Method and path | Behavior |
| --- | --- |
| `GET /admin` | Returns the admin service identity. |
| `GET /admin/health` | Checks the configured PostgreSQL connection, key-value store, and JsonDB. The response body reports `healthy` or `degraded`. |
| `GET /admin/logs` | Accepts `type=audit` (default) or `type=system`. `limit` defaults to 100 and is capped at 500. System logs come from the current log file. |
| `GET /admin/keys` | Lists API key records. |
| `GET /admin/keys/:id` | Gets one API key record by its record ID. |
| `POST /admin/keys` | Creates a key for `database` or `databases`. `environment` accepts `LIVE` (default) or `TEST`. Save `data.apiKey` from the creation response. |
| `PATCH /admin/keys/:id`, `PUT /admin/keys/:id` | Replaces an active key's scope with the supplied nonempty `databases` array. |
| `DELETE /admin/keys/:id` | Revokes the key. Add `?hard=true` to remove its record permanently. |
| `GET /admin/databases` | Lists non-template databases. |
| `GET /admin/databases/:name` | Gets database metadata, including ownership, encoding, and size when available. |
| `POST /admin/databases` | Creates a database. Send `name` or `database`. Optional fields include `owner`, `template`, `encoding`, `lcCollate`, `lcCtype`, `tablespace`, and `connectionLimit`. |
| `PATCH /admin/databases/:name`, `PUT /admin/databases/:name` | Updates `newName`, `owner`, `allowConnections`, `connectionLimit`, `settings`, or `resetSettings`. |
| `DELETE /admin/databases/:name` | Drops a database. Add `?force=true` to ask PostgreSQL to terminate existing connections. |

Database administration uses the PostgreSQL role in the connection URL. Renaming or dropping a database updates stored API-key scopes. The gateway restricts destructive operations on `postgres`, `template0`, and `template1`. PostgreSQL requires a connection to another database to rename or drop the gateway's configured connection database.

## Errors and rate limits

Errors generally use `{"success":false,"error":{"code":"…","message":"…"}}`. A missing or rejected credential returns `401`, missing inputs usually return `400`, and a request beyond a rate limit returns `429` with `Retry-After`.
