# Routes

The default base URL is `http://localhost:8080`. Send JSON bodies with `Content-Type: application/json`.

| Routes | Authentication |
| --- | --- |
| `GET /health`, `HEAD /health` | Public and exempt from request limits. `GET` returns `{"status":"ok"}`. |
| `/admin` | Put the admin password in `x-admin`. |
| `/query`, `/transaction` | Send `x-api-key` and `x-database`. The key must be active and scoped to the named database. |

Query and transaction routes also accept the raw key in `Authorization` and the database name in `x-db-name`. Send the raw key without a `Bearer` prefix.

## Immediate queries

`POST /query` and `POST /query/run` run SQL immediately.

```json
{"query":"SELECT $1::integer AS value","parameters":[42]}
```

`query` is required. `parameters` is optional and accepts the alias `params`. A single-statement response includes `database`, `command`, `rowCount`, `rows`, `fields`, and `durationMs`. The `data` field repeats the result metadata and rows. When PostgreSQL returns multiple statement results, the response uses a `results` array ordered by statement.

The gateway checks the database name, identity, and query login before running SQL. Session state lasts for the request. Connection acquisition waits up to 5 seconds, and the gateway initializes the session's PostgreSQL `statement_timeout` to 30 seconds. The client also has a 35-second query response timeout. PostgreSQL allows SQL clients to change the session setting.

Pass `options.arrayMode: true` to receive positional rows. Duplicate column names are preserved and `fields` follows the same order as the row. Set `options.fullResults: false` to return just the rows for each statement while retaining the API response envelope. The default includes the result metadata.

By default, JSON and JSONB, dates, timestamps, intervals, and their PostgreSQL arrays are returned as PostgreSQL text so values retain their precision. A `numeric[]` result preserves the array shape and returns non-null elements as exact decimal strings. Non-finite scalar floating-point values are returned as strings. Set `options.lossless: false` to use the driver's legacy conversions. Use strings for input numbers that exceed JSON's safe integer range.

The JSON routes reject `COPY FROM STDIN` and `COPY TO STDOUT` with `COPY_STREAM_UNSUPPORTED`. For immediate SQL, the code appears in `error.cause` because earlier statements in the same request could have taken effect.

A query response or transaction batch can retain up to 50,000 result rows and approximately 8 MiB of result data and metadata. Immediate queries have a 35-second request deadline. If the gateway loses the result after sending immediate SQL, it returns `500 QUERY_OUTCOME_UNKNOWN` with the underlying reason in `error.cause`. This includes result-limit and deadline interruptions. Immediate SQL can commit on the server before the gateway detects an interruption. Verify any writes before retrying. Transaction execution has one 60-second deadline across acquisition, all statements, and commit. If the gateway has already sent `COMMIT` and cannot confirm the outcome, verify whether it committed before retrying.

## Single-request transactions

`POST /transaction/execute` accepts 1 to 100 statements in an ordered JSON array. Each entry can be a SQL string or an object with `query` and optional `parameters`. An outer `BEGIN` and `COMMIT` pair is optional. The gateway manages the actual transaction boundary. Use an array so statements keep their order and repeated JSON keys cannot overwrite them.

The gateway saves the batch in PostgreSQL and returns `202 Accepted` with `transactionId`, `status: "pending"`, and a `Location` header. Poll `GET /transaction/:id` or `GET /transaction` with the `transaction-id` header using the same API key and database. The lookup returns `progress.completed` and `progress.total` while the batch runs. Accepted work continues if the submission request disconnects.

Set an `Idempotency-Key` before the first submission if you might retry it. Use 1 to 128 letters, digits, or `._~-`. Within the same API key and database, repeating the key with the same normalized batch returns the original `202` receipt and transaction ID. Reusing the key for different SQL, parameters, or options returns `409 IDEMPOTENCY_KEY_CONFLICT`. The key remains reserved until the configured retention period has elapsed and the transaction record is gone.

The first shutdown signal stops the server and lets accepted batches finish. A second signal forces an exit. Set the service manager's shutdown grace period to accommodate the 60-second execution deadline and transaction-store writes.

| Status | Meaning |
| --- | --- |
| `pending`, `running`, `committing` | The batch has been accepted and has yet to reach a final outcome. |
| `committed` | All statements committed. Read `outcome.payload.results` for the results. |
| `rejected` | The batch was rolled back. Read `outcome.payload.error` for the error and, when a statement failed, its zero-based `queryIndex` and PostgreSQL diagnostics. |
| `failed` | Execution did not reach a successful commit. |
| `unknown` | The commit outcome could not be confirmed. Verify it before resubmitting. |

Execution records survive gateway restarts. The gateway stages the results before sending `COMMIT`. It publishes them only after PostgreSQL confirms the commit and the gateway saves the `committed` status. A crash or prolonged storage outage near commit can still leave the status uncertain. Interrupted batches are never replayed automatically. After the execution window, a stalled record is reported as `failed` or `unknown` with `finalized: false`. Only records with `finalized: true` can be deleted with `DELETE /transaction/:id` or the header-based delete route. After a database rename, use its new name with the same, updated API key to look up or delete saved records. Deleting a record does not undo committed SQL.

```json
{
  "queries": [
    {"query": "INSERT INTO users(name) VALUES ($1)", "parameters": ["John"]},
    {"query": "UPDATE stats SET users = users + 1"}
  ],
  "options": {
    "isolationLevel": "serializable",
    "readOnly": false,
    "deferrable": false,
    "arrayMode": true,
    "fullResults": true
  }
}
```

The same `options` object is accepted when creating a queued transaction. Isolation values are `read uncommitted`, `read committed`, `repeatable read`, and `serializable`, case-insensitively. Boolean settings select PostgreSQL's native read-only or read-write and deferrable or not-deferrable modes. Omitted modes use PostgreSQL defaults. Each entry must contain one SQL statement. Transactions with explicitly selected modes reserve `SET` and `RESET` for the gateway. [PostgreSQL BEGIN](https://www.postgresql.org/docs/current/sql-begin.html)

## Queued transactions

Use the same API key and database for every request in a transaction. Queues live in process memory and are lost on restart. Creating a transaction, adding or removing queries, and reading the queue require no PostgreSQL connection. A record expires 15 minutes after creation, the last queue edit, or the end of a commit attempt. Commits in progress are retained. Each queue can hold 100 statements and 256 KiB of estimated queue memory. Each process stores up to 1,000 transaction records and 16 MiB of estimated queue memory. The estimate includes string storage and fixed charges for each transaction, query, and lookup.

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

If a statement fails, the gateway rolls back and returns the failing `queryId`. When PostgreSQL explicitly rejects the commit, the gateway returns `TRANSACTION_ROLLED_BACK` and includes the PostgreSQL error code when available. Both cases return the transaction to `pending` so you can edit and retry. If the commit outcome cannot be confirmed, the status becomes `failed` and the API rejects further commit attempts.

## Administration

| Method and path | Behavior |
| --- | --- |
| `GET /admin` | Returns the admin service identity. |
| `GET /admin/health` | Checks the configured PostgreSQL connection, key-value store, and JsonDB. The response body reports `healthy` or `degraded`. |
| `GET /admin/logs` | Accepts `type=audit` (default) or `type=system`. `limit` defaults to 100 and is capped at 500. System logs come from the current file. Audit logs include the previous generation when needed. Reads scan up to 1 MiB per file. |
| `GET /admin/keys` | Lists API key records. |
| `GET /admin/keys/:id` | Gets one API key record by its record ID. |
| `POST /admin/keys` | Creates a key from a `databases` privilege map. Name-only keys can use `database` or a `databases` array. `environment` accepts `LIVE` (default) or `TEST`. Save `data.apiKey` from the creation response. |
| `PATCH /admin/keys/:id`, `PUT /admin/keys/:id` | Replaces an active key's complete database and privilege assignment. Explicitly scoped keys require a `databases` privilege map. |
| `DELETE /admin/keys/:id` | Revokes the key. Add `?hard=true` to remove its record permanently. |
| `GET /admin/databases` | Lists non-template databases. |
| `GET /admin/databases/:name` | Gets database metadata, including ownership, encoding, and size when available. |
| `POST /admin/databases` | Creates a database. Send `name` or `database`. Optional fields include `owner`, `template`, `encoding`, `lcCollate`, `lcCtype`, `tablespace`, and `connectionLimit`. |
| `PATCH /admin/databases/:name`, `PUT /admin/databases/:name` | Updates `newName`, `owner`, `allowConnections`, `connectionLimit`, `settings`, or `resetSettings`. |
| `DELETE /admin/databases/:name` | Drops a database. Add `?force=true` to ask PostgreSQL to terminate existing connections. |

Database administration uses the role configured in `database.url`. Databases created through the gateway require explicit `CONNECT` grants for application roles. Database updates run in one PostgreSQL transaction. Renaming or dropping a database also updates stored API-key scopes. A failure to update the local scope file after PostgreSQL succeeds is reported with a `PARTIAL_*` error. The gateway restricts destructive operations on `postgres`, `template0`, and `template1`. PostgreSQL requires a connection to another database to rename or drop the gateway's configured connection database.

## API-key privileges by database

Send a map of database names to PostgreSQL privileges when creating or updating a key. A single key can have a different set for each database.

```json
{
  "databases": {
    "sales": ["SELECT"],
    "events": ["SELECT", "INSERT"]
  }
}
```

Each privilege list must match an exact [configured query profile](configuration.md#query-database-access). Case and order are ignored. Supported names are `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `CREATE`, `CONNECT`, `TEMPORARY`, `EXECUTE`, `USAGE`, and `MAINTAIN`. Availability depends on the PostgreSQL version and the target object. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

Key records expose the assignment in `databaseScopes`. Query requests still supply `x-database` to choose the target. PostgreSQL applies that database's selected login privileges. Queued commits use the permissions in effect when the commit request authenticates. Existing name-only keys continue to use the default login configured for each database.

## Errors and rate limits

Errors generally use `{"success":false,"error":{"code":"…","message":"…"}}`. A missing or rejected credential returns `401`, missing inputs usually return `400`, and a request beyond a rate limit returns `429` with `Retry-After`.

| Error | Meaning |
| --- | --- |
| `401 API_KEY_SCOPE_REBIND_REQUIRED` | An older key needs an administrator to resave its database scope. |
| `400 INVALID_DATABASE_SCOPE` | A database-to-privileges map or one of its privilege lists is invalid. |
| `400 UNCONFIGURED_DATABASE_SCOPE` | The database lacks a query profile with exactly the requested privileges. |
| `400 DATABASE_SCOPES_REQUIRED` | Updating an explicitly scoped key requires a database-to-privileges map. |
| `403 DATABASE_SCOPE_CHANGED` | The database identity differs from the key's stored scope. |
| `403 INSUFFICIENT_PRIVILEGE` | PostgreSQL denied the query login permission to run the SQL. |
| `409 DATABASE_IN_USE` | The database is under gateway maintenance. |
| `413 TRANSACTION_QUEUE_LIMIT_EXCEEDED` | The transaction exceeds its statement or byte limit. |
| `429 TRANSACTION_LIMIT_EXCEEDED` | The process has reached its transaction storage limit. |
| `503 QUERY_POOL_BUSY` | The selected database and profile pool is full. |
| `413 RESULT_LIMIT_EXCEEDED` | A transaction exceeded the result budget before commit. |
| `504 EXECUTION_DEADLINE_EXCEEDED` | Execution exceeded its deadline before immediate SQL or a transaction commit was sent. |
| `500 QUERY_OUTCOME_UNKNOWN` | Immediate SQL was sent and may have taken effect. Check the underlying reason in `error.cause` and verify any writes before retrying. |
| `503 QUERY_CONNECTION_LIMIT` | The process-wide query connection budget is full. |
| `503 QUERY_DATABASE_UNAVAILABLE` | The requested database's dedicated connection could not be opened or verified. |

PostgreSQL errors during SQL execution include the SQLSTATE in `pgCode` and structured fields for severity, schema, table, column, constraint, data type, and position where available. The `detail` and `hint` fields are null by default because PostgreSQL can include data values or internal context. Trusted deployments can enable them with `database.exposeErrorDetails`.
