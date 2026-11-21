# Routes

The default base URL is `http://localhost:8080`. Send JSON bodies with `Content-Type: application/json`.

| Routes | Authentication |
| --- | --- |
| `GET /health`, `HEAD /health` | Public and exempt from request limits. `GET` returns `{"status":"ok"}`. |
| `/admin/*` | Put the gateway admin password in `x-admin`. |
| `/query`, `/transaction` | Send `x-api-key` and `x-database`. The key must be active and scoped to the named database. |

Query and transaction routes also accept the raw key in `Authorization` and the database name in `x-db-name`. Send the raw key without a `Bearer` prefix.

## Immediate queries

`POST /query` and `POST /query/run` run SQL immediately.

```json
{"query":"SELECT $1::integer AS value","parameters":[42]}
```

`query` is required. `parameters` is optional and accepts the alias `params`. A single-statement response includes `database`, `command`, `rowCount`, `rows`, `fields`, and `durationMs`. The `data` field repeats the result metadata and rows. When PostgreSQL returns multiple statement results, the response uses a `results` array ordered by statement.

The gateway prewarms query connections and checks the database name, identity, and login before running SQL. A connection can serve repeated requests from the same API key. After each request, the gateway rolls back any open transaction and resets PostgreSQL session state with `DISCARD ALL` before checking the connection back in. A timed-out or disconnected request, a failed reset, or a different API key causes the connection to close. PostgreSQL extensions can keep backend-local state beyond the standard reset, so reusable sessions stay scoped to a key. Connection acquisition waits up to 5 seconds, and the gateway sets PostgreSQL `statement_timeout` to 30 seconds at checkout. The client also has a 35-second query response timeout. PostgreSQL allows SQL clients to change the session setting. [PostgreSQL DISCARD](https://www.postgresql.org/docs/18/sql-discard.html)

Pass `options.arrayMode: true` to receive positional rows. Duplicate column names are preserved and `fields` follows the same order as the row. Set `options.fullResults: false` to return just the rows for each statement while retaining the API response envelope. The default includes the result metadata.

By default, JSON and JSONB, dates, timestamps, intervals, and their PostgreSQL arrays are returned as PostgreSQL text so values retain their precision. A `numeric[]` result preserves the array shape and returns non-null elements as exact decimal strings. Non-finite scalar floating-point values are returned as strings. Set `options.lossless: false` to use the driver's legacy conversions. Use strings for input numbers that exceed JSON's safe integer range.

The JSON routes reject `COPY FROM STDIN` and `COPY TO STDOUT` with `COPY_STREAM_UNSUPPORTED`. For immediate SQL, the code appears in `error.cause` because earlier statements in the same request could have taken effect.

A query response or transaction batch can retain up to 50,000 result rows and approximately 8 MiB of result data and metadata. Immediate queries have a 35-second request deadline. If the gateway loses the result after sending immediate SQL, it returns `500 QUERY_OUTCOME_UNKNOWN` with the underlying reason in `error.cause`. This includes result-limit and deadline interruptions. Immediate SQL can commit on the server before the gateway detects an interruption. Verify any writes before retrying. Transaction execution has one 60-second deadline across acquisition, all statements, and commit. If the gateway has already sent `COMMIT` and cannot confirm the outcome, verify whether it committed before retrying.

## Asynchronous queries

Send `type: "async"` to either query POST endpoint. Omit `type` or use `"sync"` for an immediate response.

```json
{"type":"async","query":"SELECT $1::integer AS value","parameters":[42]}
```

The gateway returns `202 Accepted` with `queryId`, `status: "running"`, and a `Location` header. Poll `GET /query/:id` with the same API key and database. You can also send `query-id` or `x-query-id` to `GET /query`, or use `?queryId=…`.

While SQL is running, polls return `finalized: false`. Once `finalized` is true, the response includes `outcome.status` with the HTTP status the query would have returned directly and `outcome.payload` with its results or error. GET requests can be repeated. After receiving the result, send `DELETE /query/:id` with the same API key and database. Deleting a running query returns `409 QUERY_IN_PROGRESS`. After removal, GET returns `404 QUERY_NOT_FOUND`.

Async statements have a five-minute PostgreSQL statement timeout and the same result limits as immediate queries. Each gateway process accepts up to 32 concurrent asynchronous queries. Accepted work continues after the submission disconnects and during graceful shutdown. Stored outcomes survive gateway restarts. If the gateway loses the outcome, polls report `status: "unknown"` and `QUERY_OUTCOME_UNKNOWN` after the execution window expires.

## Single-request transactions

`POST /transaction/execute` accepts 1 to 100 statements in an ordered JSON array. Each entry can be a SQL string or an object with `query` and optional `parameters`. An outer `BEGIN` and `COMMIT` pair is optional. The gateway manages the actual transaction boundary. Use an array so statements keep their order and repeated JSON keys cannot overwrite them.

The gateway saves the batch in PostgreSQL and returns `202 Accepted` with `transactionId`, `status: "pending"`, and a `Location` header. Poll `GET /transaction/:id` or `GET /transaction` with the `transaction-id` header using the same API key and database. The lookup returns `progress.completed` and `progress.total` while the batch runs. Saved completion counts only move forward. Accepted work continues if the submission request disconnects. GET requests can be repeated. After receiving the final outcome, send `DELETE /transaction/:id`. After removal, GET returns `404 TRANSACTION_NOT_FOUND` or `410 TRANSACTION_RECORD_REMOVED` when the batch has an idempotency key.

Set an `Idempotency-Key` before the first submission if you might retry it. Use 1 to 128 letters, digits, or `._~-`. Within the same API key and database, repeating the key with the same normalized batch returns `200 OK` with the original transaction ID, its current `status` and `finalized` flag, and a `Location` to poll for progress and results. Reusing the key for different SQL, parameters, or options returns `409 IDEMPOTENCY_KEY_CONFLICT`.

The fingerprint ignores the order of option fields and treats explicit result-format defaults like omitted values. SQL text, statement order, parameter order, and the order of object keys inside SQL parameters remain significant because PostgreSQL can observe them. Tombstones created by an earlier release with only the original fingerprint accept replays of the original normalized input.

Deleting or pruning a finalized keyed record removes its inputs and results. The gateway keeps a tombstone with the original transaction ID, final status, and removal time for the configured retention period after removal. Replays and status lookups return `410 TRANSACTION_RECORD_REMOVED` while that tombstone exists. Records removed before this change can have a tombstone without the final status or removal time.

The first shutdown signal stops the server and lets accepted batches finish. A second signal forces an exit. Set the service manager's shutdown grace period to accommodate execution and storage writes. Transactions have a 60-second execution deadline. Asynchronous queries allow up to 305 seconds for acquisition and execution.

| Status | Meaning |
| --- | --- |
| `pending`, `running`, `committing` | The batch has been accepted and has yet to reach a final outcome. |
| `committed` | All statements committed. Read `outcome.payload.results` for the results. |
| `rejected` | The batch was rolled back. Read `outcome.payload.error` for the error and, when a statement failed, its zero-based `queryIndex` and PostgreSQL diagnostics. |
| `failed` | Execution did not reach a successful commit. |
| `unknown` | The commit outcome could not be confirmed. Verify it before resubmitting. |

Execution records survive gateway restarts. The gateway stages the results before sending `COMMIT`. It publishes them only after PostgreSQL confirms the commit and the gateway saves the `committed` status. A crash or prolonged storage outage near commit can still leave the status uncertain. Interrupted batches are never replayed automatically. After the execution window, a stalled record is reported as `failed` or `unknown` with `finalized: true`. Finalized records can be deleted with `DELETE /transaction/:id` or the header-based delete route. Deleting a batch that is still running returns `409 TRANSACTION_IN_PROGRESS`. After a database rename, use its new name with the same, updated API key to look up or delete saved records. Deleting a record does not undo committed SQL.

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
| `GET /transaction` | Send `transaction-id`, or look up the containing transaction with the `query-id` header or `?queryId=…`. Returns the transaction status and queued SQL. |
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
| `GET /admin/health` | Checks PostgreSQL, the key-value store, JsonDB, and query-connection monitoring. Includes query capacity metrics and reports `healthy` or `degraded`. |
| `GET /admin/logs` | Accepts `type=audit` (default) or `type=system`. `limit` defaults to 100 and is capped at 500. System logs come from the current file. Audit logs include the previous generation when needed. Reads scan up to 1 MiB per file. |
| `GET /admin/analytics` | Returns total and failed query counts, usage by API key ID, and recent failed SQL. `limit` defaults to 50 and is capped at 200. |
| `GET /admin/keys` | Lists API key records. |
| `GET /admin/keys/:id` | Gets one API key record by its record ID. |
| `POST /admin/keys` | Creates a key with database and table CRUD scopes. `environment` accepts `LIVE` (default) or `TEST`. Save `data.apiKey` from the creation response. |
| `PATCH /admin/keys/:id`, `PUT /admin/keys/:id` | Replaces the complete scope of an active key. |
| `DELETE /admin/keys/:id` | Revokes the key. Add `?hard=true` to remove its record permanently. |
| `GET /admin/database` | Lists all database names in the PostgreSQL cluster. |
| `GET /admin/database/:id` | Accepts a database name or PostgreSQL OID. Returns the OID as `id`, ownership, encoding, server version, recorded collation version, and size when available. |
| `POST /admin/database` | Creates a database. Send `name` or `database`. Optional fields include `owner`, `template`, `encoding`, `lcCollate`, `lcCtype`, `tablespace`, and `connectionLimit`. |
| `PUT /admin/database` | Refreshes the recorded database collation version on PostgreSQL 15+. Send `{"database":"sales","version":"collation"}` after rebuilding objects affected by the collation change. PostgreSQL server upgrades are cluster-wide operations. |
| `PATCH /admin/database` | Updates `newName`, `owner`, `allowConnections`, `connectionLimit`, `settings`, or `resetSettings`. Send the target in `database` or `id`. |
| `GET /admin/table` | Lists regular and partitioned tables in the database selected by `x-database`. Each entry includes `oid`, `schema`, and `name`. |
| `DELETE /admin/databases/:name` | Drops a database. Add `?force=true` to ask PostgreSQL to terminate existing connections. |

Database administration uses the PostgreSQL administrator configured in `database.url`. Databases created through the gateway require explicit `CONNECT` grants for application roles. Renaming or dropping a database also updates stored API-key scopes. A failure to update the local scope file after PostgreSQL succeeds is reported with a `PARTIAL_*` error. PostgreSQL requires a connection to another database to rename or drop the gateway's configured connection database.

The previous plural database routes remain available, including `PUT /admin/databases/:name` for property changes.

Analytics counts completed query executions and each attempted statement in a transaction. A legacy query submission containing multiple statements counts once. Polling, idempotent replays, and statements skipped after a batch error leave counts unchanged. Transaction counts reflect statement execution even when a later statement causes a rollback.

Only failed SQL is stored in analytics, with the SQLSTATE and gateway error code where available. SQL text is limited to 8,192 characters per failure. Bound values are omitted from analytics and new transaction inputs. Use placeholders for sensitive inputs because SQL literals remain part of the statement text.

## API-key database and table scopes

When key creation supplies `database` or `databases` without `scope-database`, `scope-table`, or `tables`, the new key receives create, read, update, and delete access to every current user table in each assigned database. Resave the scope after adding tables so their grants are included.

Send the database names in `database` and the database-wide operations in `scope-database`. Use `tables` and `scope-table` to add operations for selected tables. In this example, the key can read all current user tables in `sales` and insert into `public.orders`.

```json
{
  "database": ["sales"],
  "scope-database": ["r"],
  "tables": ["public.orders"],
  "scope-table": ["c"]
}
```

Use `c` for INSERT, `r` for SELECT, `u` for UPDATE, and `d` for DELETE. An empty `scope-database` makes a key table-only. Use `{"database":"sales","schema":"public","name":"orders"}` for table entries in a multi-database key. For a single database, use `schema.table` or an unqualified table name in `public`.

The gateway creates a separate PostgreSQL login for each distinct grant set. PostgreSQL checks permissions on queries and transactions, including any SELECT privileges needed for `RETURNING` or for reading columns in a write statement. Scoped SQL requests accept one data statement at a time. A key with only read access uses PostgreSQL read-only transactions. Inherited and partitioned tables require matching privileges on descendants for any operation that can reach them. Database-wide grants cover the tables present when the key is saved. Resave the key to include new tables or sequences used by new column defaults. Queued commits use the permissions in effect when the commit request authenticates. [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html)

Existing name-only assignments use `database` as a string or `databases` as an array and connect through the corresponding default login in `queryUrls`.

## Errors and rate limits

Errors generally use `{"success":false,"error":{"code":"…","message":"…"}}`. A missing or rejected credential returns `401`, missing inputs usually return `400`, and a request beyond a rate limit returns `429` with `Retry-After`.

| Error | Meaning |
| --- | --- |
| `401 API_KEY_SCOPE_REBIND_REQUIRED` | An older key needs an administrator to resave its database scope. |
| `400 INVALID_DATABASE_SCOPE`, `INVALID_TABLE_SCOPE` | A database or table scope is invalid or incomplete. |
| `400 DATABASE_SCOPES_REQUIRED` | Updating an explicitly scoped key requires CRUD scopes. |
| `404 TABLE_NOT_FOUND` | A table in the requested scope is missing. |
| `409 UNSAFE_DATABASE_SCOPE` | PostgreSQL grants outside the requested scopes prevent provisioning a scoped login. |
| `422 DATABASE_VERSION_UNSUPPORTED` | The version request requires the collation operation supported in PostgreSQL 15 and later. |
| `403 DATABASE_SCOPE_CHANGED` | The database identity differs from the key's stored scope. |
| `403 INSUFFICIENT_PRIVILEGE` | PostgreSQL denied the query login permission to run the SQL. |
| `409 DATABASE_IN_USE` | The database is under gateway maintenance. |
| `413 TRANSACTION_QUEUE_LIMIT_EXCEEDED` | The transaction exceeds its statement or byte limit. |
| `429 TRANSACTION_LIMIT_EXCEEDED` | The process has reached its transaction storage limit. |
| `400 INVALID_QUERY_TYPE` | The query type was neither `async` nor `sync`. |
| `404 QUERY_NOT_FOUND` | The asynchronous query record is missing for this key and database. |
| `409 QUERY_IN_PROGRESS`, `TRANSACTION_IN_PROGRESS` | The execution record is still active and cannot be deleted. |
| `503 QUERY_QUEUE_FULL` | The process has reached the concurrent asynchronous-query limit. |
| `503 QUERY_STORE_UNAVAILABLE` | The gateway could not save, retrieve, or delete the asynchronous query record. |
| `503 QUERY_POOL_BUSY` | A checkout waited 400 ms and the selected PostgreSQL login pool was at capacity. |
| `413 RESULT_LIMIT_EXCEEDED` | A transaction exceeded the result budget before commit. |
| `504 EXECUTION_DEADLINE_EXCEEDED` | Execution exceeded its deadline before immediate SQL or a transaction commit was sent. |
| `500 QUERY_OUTCOME_UNKNOWN` | SQL was sent and may have taken effect. Check the underlying reason in `error.cause` and verify any writes before retrying. |
| `503 QUERY_CONNECTION_LIMIT` | A checkout waited 400 ms and the process-wide query connection budget was full. |
| `503 QUERY_POOL_WAIT_TIMEOUT` | No verified PostgreSQL session became available within the 400 ms checkout deadline. |
| `503 QUERY_DATABASE_UNAVAILABLE` | The requested database's dedicated connection could not be opened or verified. |

Immediate PostgreSQL errors include the SQLSTATE in `pgCode` and structured fields for severity, schema, table, column, constraint, data type, and position where available. The `detail` and `hint` fields are null by default because PostgreSQL can include data values or internal context. Trusted deployments can enable them with `database.exposeErrorDetails`.

Saved async query and transaction errors retain SQLSTATE, gateway code, and the failing statement identifier when available. Their messages omit PostgreSQL diagnostic text that may quote bound values.
