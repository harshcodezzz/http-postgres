import { Client, escapeLiteral, Pool, type PoolClient } from "pg";
import config from "../config/index.js";
import type { JsonDB } from "../plugins/jsondb.js";

export class DatabaseError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "DatabaseError";
  }
}

export const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);


function withoutDatabases<T>(entries: Record<string, T>, ...names: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([name]) => !names.includes(name)));
}

function renameDatabaseScope<T>(
  entries: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  return {
    ...withoutDatabases(entries, from, to),
    ...(Object.hasOwn(entries, from) && { [to]: entries[from] }),
  };
}

function getPgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toDatabaseError(
  err: unknown,
  fallbackMessage: string,
): DatabaseError | null {
  if (err instanceof DatabaseError) {
    return err;
  }

  const code = getPgErrorCode(err);
  switch (code) {
    case "42P04":
      return new DatabaseError(fallbackMessage, "DATABASE_ALREADY_EXISTS");
    case "3D000":
      return new DatabaseError(fallbackMessage, "DATABASE_NOT_FOUND");
    case "42501":
      return new DatabaseError(
        "Insufficient privileges to perform database operation",
        "INSUFFICIENT_PRIVILEGE",
      );
    case "55006":
      return new DatabaseError(
        "Database is currently in use by active connections",
        "DATABASE_IN_USE",
      );
    case "42704":
      return new DatabaseError(fallbackMessage, "OBJECT_NOT_FOUND");
    case "22023":
      return new DatabaseError(fallbackMessage, "INVALID_PARAMETER_VALUE");
    default:
      return null;
  }
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteGucIdentifier(param: string): string {
  return param.split(".").map(quoteIdentifier).join(".");
}

function isValidGucParameterName(param: string): boolean {
  if (typeof param !== "string" || param.length === 0) return false;
  const segments = param.split(".");
  return segments.every((segment) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment));
}

async function inDatabaseTransaction(pool: Pool, operation: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  client.on("error", (error) => {
    if (pool.listenerCount("error") > 0) pool.emit("error", error, client);
  });
  try {
    await client.query("BEGIN");
    await operation(client);
    const result = await client.query("COMMIT");
    if (result.command !== "COMMIT") {
      throw new DatabaseError("PostgreSQL rolled back database maintenance", "DATABASE_MAINTENANCE_ROLLED_BACK");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release(true);
  }
}

function requireDatabasePool<T extends Pick<Pool, "query">>(pool: T | undefined): T {
  if (!pool) {
    throw new Error("An application-owned PostgreSQL pool is required");
  }
  return pool;
}

/**
 * Validates whether a database name complies with PostgreSQL identifier rules.
 */
export function isValidDatabaseName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 63) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(name);
}

function isPostgresIdentifier(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 63;
}

/**
 * Checks whether a database exists in PostgreSQL using parameterized query.
 */
export async function checkDatabaseExists(
  databaseName: string,
  pool?: Pool,
): Promise<boolean> {
  return !!await getPostgresDatabaseOid(databaseName, pool);
}

export async function getPostgresDatabaseOid(
  databaseName: string,
  pool?: Pick<Pool, "query">,
): Promise<string | undefined> {
  if (!isPostgresIdentifier(databaseName)) {
    return undefined;
  }

  const pg = requireDatabasePool(pool);

  try {
    const { rows } = await pg.query<{ oid: string }>(
      "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname::pg_catalog.text = $1 AND NOT datistemplate",
      [databaseName],
    );
    return rows[0]?.oid;
  } catch (err: unknown) {
    const mapped = toDatabaseError(
      err,
      "Insufficient privileges to verify database in pg_database",
    );
    if (mapped) throw mapped;
    throw err;
  }
}

/**
 * Lists databases from the PostgreSQL catalog.
 */
export async function listPostgresDatabases(pool?: Pool, includeTemplates = false): Promise<string[]> {
  const pg = requireDatabasePool(pool);
  try {
    const res = await pg.query<{ datname: string }>(
      "SELECT datname FROM pg_catalog.pg_database WHERE $1 OR NOT datistemplate ORDER BY datname",
      [includeTemplates],
    );
    return res.rows.map((r) => r.datname);
  } catch (err: unknown) {
    const mapped = toDatabaseError(err, "Failed to list PostgreSQL databases");
    if (mapped) throw mapped;
    throw err;
  }
}

export function databaseUrl(name: string): URL {
  const source = config.database.url;
  const url = source.startsWith("/") ? new URL("postgresql:///") : new URL(source);
  if (source.startsWith("/")) url.searchParams.set("host", source.split(" ")[0]);
  if (url.protocol === "socket:") url.searchParams.set("db", name);
  else url.pathname = encodeURIComponent(name);
  url.searchParams.delete("dbname");
  url.searchParams.delete("database");
  return url;
}

export async function withPostgresDatabase<T>(
  name: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: databaseUrl(name).toString(),
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    throw toDatabaseError(error, `Database operation failed for '${name}'`) ?? error;
  } finally {
    await client.end();
  }
}

export async function listPostgresTables(client: Pick<Client, "query">) {
  const { rows } = await client.query<{ oid: string; schema: string; name: string }>(`
    SELECT c.oid::text, n.nspname AS schema, c.relname AS name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND c.relpersistence <> 't'
      AND n.nspname <> ALL(ARRAY['information_schema', 'http_postgres_gateway'])
      AND pg_catalog.left(n.nspname, 3) <> 'pg_'
    ORDER BY n.nspname, c.relname
  `);
  return rows;
}

export interface PostgresDatabaseDetails {
  id: string;
  name: string;
  serverVersion: string;
  collationVersion: string | null;
  owner: string;
  encoding: string;
  lcCollate: string;
  lcCtype: string;
  connectionLimit: number;
  allowConnections: boolean;
  sizeBytes?: number;
  sizePretty?: string;
}

/**
 * Retrieves database attributes and storage metadata from PostgreSQL.
 */
export async function getPostgresDatabaseDetails(
  databaseName: string,
  pool?: Pool,
  includeTemplates = false,
  by: "name" | "id" = "name",
): Promise<PostgresDatabaseDetails | null> {
  if (by === "id") {
    if (!/^[0-9]{1,10}$/.test(databaseName) || Number(databaseName) > 4_294_967_295) return null;
  } else {
    if (!isPostgresIdentifier(databaseName)) return null;
  }

  const pg = requireDatabasePool(pool);

  try {
    const res = await pg.query<{
      id: string;
      datname: string;
      server_version: string;
      collation_version: string | null;
      owner: string;
      encoding: string;
      lc_collate: string;
      lc_ctype: string;
      connection_limit: number;
      allow_connections: boolean;
      size_bytes: string | null;
      size_pretty: string | null;
    }>(
      `WITH details AS MATERIALIZED (
        SELECT d.oid::pg_catalog.text AS id, d.datname,
          pg_catalog.current_setting('server_version') AS server_version,
          pg_catalog.to_jsonb(d)->>'datcollversion' AS collation_version,
          pg_catalog.pg_get_userbyid(d.datdba) AS owner,
          pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
          d.datcollate AS lc_collate,
          d.datctype AS lc_ctype,
          d.datconnlimit AS connection_limit,
          d.datallowconn AS allow_connections,
          CASE WHEN pg_catalog.has_database_privilege(d.oid, 'CONNECT')
                 OR pg_catalog.pg_has_role('pg_read_all_stats', 'USAGE')
            THEN pg_catalog.pg_database_size(d.oid)
          END AS bytes
        FROM pg_catalog.pg_database d
        WHERE ${by === "id" ? "d.oid = $1::pg_catalog.oid" : "d.datname::pg_catalog.text = $1"}
          AND ($2 OR NOT d.datistemplate)
        LIMIT 1
      )
      SELECT id, datname, server_version, collation_version, owner, encoding, lc_collate, lc_ctype, connection_limit, allow_connections,
        bytes::pg_catalog.text AS size_bytes,
        pg_catalog.pg_size_pretty(bytes) AS size_pretty
      FROM details`,
      [databaseName, includeTemplates],
    );

    if (res.rowCount === 0 || !res.rows[0]) {
      return null;
    }

    const row = res.rows[0];
    const parsedSize = row.size_bytes ? Number(row.size_bytes) : undefined;
    const sizeBytes =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize)
        ? parsedSize
        : undefined;

    return {
      id: row.id,
      name: row.datname,
      serverVersion: row.server_version,
      collationVersion: row.collation_version,
      owner: row.owner,
      encoding: row.encoding,
      lcCollate: row.lc_collate,
      lcCtype: row.lc_ctype,
      connectionLimit: Number(row.connection_limit),
      allowConnections: Boolean(row.allow_connections),
      sizeBytes,
      sizePretty: row.size_pretty ?? undefined,
    };
  } catch (err: unknown) {
    const mapped = toDatabaseError(
      err,
      `Failed to retrieve details for database '${databaseName}'`,
    );
    if (mapped) throw mapped;
    throw err;
  }
}

export async function refreshPostgresDatabaseVersion(database: PostgresDatabaseDetails, pool: Pool) {
  try {
    await inDatabaseTransaction(pool, async (client) => {
      const { rows: [server] } = await client.query<{ supported: boolean }>(
        "SELECT pg_catalog.current_setting('server_version_num')::integer >= 150000 AS supported",
      );
      if (!server.supported) {
        throw new DatabaseError("Database collation version refresh requires PostgreSQL 15 or newer", "DATABASE_VERSION_UNSUPPORTED");
      }
      await client.query(`ALTER DATABASE ${quoteIdentifier(database.name)} REFRESH COLLATION VERSION`);
      if (await getPostgresDatabaseOid(database.name, client) !== database.id) {
        throw new DatabaseError("Database identity changed during maintenance", "DATABASE_IN_USE");
      }
    });
  } catch (err) {
    throw toDatabaseError(err, `Failed to refresh the collation version for '${database.name}'`) ?? err;
  }
  return getPostgresDatabaseDetails(database.id, pool, false, "id");
}

export interface CreatePostgresDatabaseOptions {
  name: string;
  owner?: string;
  template?: string;
  encoding?: string;
  lcCollate?: string;
  lcCtype?: string;
  tablespace?: string;
  connectionLimit?: number;
}

/**
 * Creates a new PostgreSQL database with optional configuration parameters.
 */
export async function createPostgresDatabase(
  nameOrOptions: string | CreatePostgresDatabaseOptions,
  pool?: Pool,
): Promise<void> {
  const options: CreatePostgresDatabaseOptions =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;

  const {
    name,
    owner,
    template,
    encoding,
    lcCollate,
    lcCtype,
    tablespace,
    connectionLimit,
  } = options;

  if (!isValidDatabaseName(name)) {
    throw new DatabaseError(
      `Invalid database name: '${name}'`,
      "INVALID_DATABASE_NAME",
    );
  }

  const pg = requireDatabasePool(pool);

  const exists = await checkDatabaseExists(name, pg);
  if (exists) {
    throw new DatabaseError(
      `Database '${name}' already exists`,
      "DATABASE_ALREADY_EXISTS",
    );
  }

  const withClauses = ["ALLOW_CONNECTIONS = false"];

  if (owner) {
    if (!isValidDatabaseName(owner)) {
      throw new DatabaseError(
        `Invalid owner identifier: '${owner}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`OWNER = ${quoteIdentifier(owner)}`);
  }

  if (template) {
    if (!isValidDatabaseName(template)) {
      throw new DatabaseError(
        `Invalid template database identifier: '${template}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`TEMPLATE = ${quoteIdentifier(template)}`);
  }

  if (encoding) {
    if (!/^[A-Za-z0-9_-]+$/.test(encoding)) {
      throw new DatabaseError(
        `Invalid encoding parameter: '${encoding}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`ENCODING = ${escapeLiteral(encoding)}`);
  }

  if (lcCollate) {
    if (!/^[A-Za-z0-9_.-]+$/.test(lcCollate)) {
      throw new DatabaseError(
        `Invalid lcCollate parameter: '${lcCollate}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`LC_COLLATE = ${escapeLiteral(lcCollate)}`);
  }

  if (lcCtype) {
    if (!/^[A-Za-z0-9_.-]+$/.test(lcCtype)) {
      throw new DatabaseError(
        `Invalid lcCtype parameter: '${lcCtype}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`LC_CTYPE = ${escapeLiteral(lcCtype)}`);
  }

  if (tablespace) {
    if (!isValidDatabaseName(tablespace)) {
      throw new DatabaseError(
        `Invalid tablespace identifier: '${tablespace}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    withClauses.push(`TABLESPACE = ${quoteIdentifier(tablespace)}`);
  }

  if (connectionLimit !== undefined) {
    if (!Number.isInteger(connectionLimit) || connectionLimit < -1) {
      throw new DatabaseError(
        "Connection limit must be an integer greater than or equal to -1",
        "INVALID_PARAMETER_VALUE",
      );
    }
    withClauses.push(`CONNECTION LIMIT = ${connectionLimit}`);
  }

  const quotedDb = quoteIdentifier(name);

  try {
    await pg.query(`CREATE DATABASE ${quotedDb} WITH ${withClauses.join(" ")}`);
  } catch (err) {
    const mapped = toDatabaseError(
      err,
      `Failed to create database '${name}' due to conflicting name or referenced object`,
    );
    if (mapped) throw mapped;
    throw err;
  }

  try {
    await inDatabaseTransaction(pg, async (client) => {
      await client.query(`REVOKE CONNECT ON DATABASE ${quotedDb} FROM PUBLIC`);
      await client.query(`ALTER DATABASE ${quotedDb} WITH ALLOW_CONNECTIONS true`);
    });
  } catch {
    throw new DatabaseError(
      `Database '${name}' was created, but its connection privileges could not be configured`,
      "PARTIAL_CREATE_ACCESS_SETUP_FAILED",
    );
  }
}

export interface AlterPostgresDatabaseOptions {
  newName?: string;
  owner?: string;
  allowConnections?: boolean;
  connectionLimit?: number;
  settings?: Record<string, string>;
  resetSettings?: string[];
}

/**
 * Updates database-level properties (rename, owner, allow connections, connection limit, configuration settings).
 */
export async function alterPostgresDatabase(
  databaseName: string,
  options: AlterPostgresDatabaseOptions,
  pool?: Pool,
  jsondb?: JsonDB,
  expectedOid?: string,
): Promise<{ database: string; renamed: boolean }> {
  if (!isPostgresIdentifier(databaseName)) {
    throw new DatabaseError(
      `Invalid database name: '${databaseName}'`,
      "INVALID_DATABASE_NAME",
    );
  }

  const pg = requireDatabasePool(pool);

  const databaseOid = await getPostgresDatabaseOid(databaseName, pg);
  if (!databaseOid) {
    throw new DatabaseError(
      `Database '${databaseName}' does not exist`,
      "DATABASE_NOT_FOUND",
    );
  }

  const isProtected = SYSTEM_DATABASES.has(databaseName.toLowerCase());

  // Upfront validation for all fields and system-database restrictions
  if (expectedOid && databaseOid !== expectedOid) {
    throw new DatabaseError("Database identity changed before maintenance", "DATABASE_IN_USE");
  }

  if (options.newName !== undefined && options.newName !== databaseName) {
    if (!isValidDatabaseName(options.newName)) {
      throw new DatabaseError(
        `Invalid new database name: '${options.newName}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    if (isProtected) {
      throw new DatabaseError(
        `Cannot rename protected database '${databaseName}'`,
        "PROTECTED_DATABASE",
      );
    }
    const newExists = await checkDatabaseExists(options.newName, pg);
    if (newExists) {
      throw new DatabaseError(
        `Database '${options.newName}' already exists`,
        "DATABASE_ALREADY_EXISTS",
      );
    }
  }

  if (options.owner !== undefined) {
    if (!isValidDatabaseName(options.owner)) {
      throw new DatabaseError(
        `Invalid owner identifier: '${options.owner}'`,
        "INVALID_DATABASE_NAME",
      );
    }
    if (isProtected) {
      throw new DatabaseError(
        `Cannot change owner of protected database '${databaseName}'`,
        "PROTECTED_DATABASE",
      );
    }
  }

  if (options.allowConnections !== undefined) {
    if (typeof options.allowConnections !== "boolean") {
      throw new DatabaseError(
        "'allowConnections' must be a boolean",
        "INVALID_PARAMETER_VALUE",
      );
    }
    if (isProtected && options.allowConnections === false) {
      throw new DatabaseError(
        `Cannot disable connections to protected database '${databaseName}'`,
        "PROTECTED_DATABASE",
      );
    }
  }

  if (options.connectionLimit !== undefined) {
    if (
      !Number.isInteger(options.connectionLimit) ||
      options.connectionLimit < -1
    ) {
      throw new DatabaseError(
        "Connection limit must be an integer greater than or equal to -1",
        "INVALID_PARAMETER_VALUE",
      );
    }
    if (isProtected && options.connectionLimit === 0) {
      throw new DatabaseError(
        `Cannot set connection limit to 0 on protected database '${databaseName}'`,
        "PROTECTED_DATABASE",
      );
    }
  }

  if (options.settings !== undefined) {
    if (
      typeof options.settings !== "object" ||
      options.settings === null ||
      Array.isArray(options.settings)
    ) {
      throw new DatabaseError(
        "'settings' must be an object of configuration parameters",
        "INVALID_PARAMETER_VALUE",
      );
    }
    for (const [param, val] of Object.entries(options.settings)) {
      if (!isValidGucParameterName(param)) {
        throw new DatabaseError(
          `Invalid configuration parameter name: '${param}'`,
          "INVALID_DATABASE_NAME",
        );
      }
      if (
        typeof val !== "string" &&
        typeof val !== "number" &&
        typeof val !== "boolean"
      ) {
        throw new DatabaseError(
          `Invalid value for configuration parameter '${param}'`,
          "INVALID_PARAMETER_VALUE",
        );
      }
    }
  }

  if (options.resetSettings !== undefined) {
    if (!Array.isArray(options.resetSettings)) {
      throw new DatabaseError(
        "'resetSettings' must be an array of configuration parameters",
        "INVALID_PARAMETER_VALUE",
      );
    }
    for (const param of options.resetSettings) {
      if (!isValidGucParameterName(param)) {
        throw new DatabaseError(
          `Invalid configuration parameter name: '${param}'`,
          "INVALID_DATABASE_NAME",
        );
      }
    }
  }

  const currentDbName = options.newName ?? databaseName;
  const renamed = currentDbName !== databaseName;
  const quotedDb = quoteIdentifier(currentDbName);

  try {
    await inDatabaseTransaction(pg, async (client) => {
      if (renamed) {
        await client.query(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} RENAME TO ${quotedDb}`,
        );
      }
      if (options.owner) {
        await client.query(
          `ALTER DATABASE ${quotedDb} OWNER TO ${quoteIdentifier(options.owner)}`,
        );
      }
      if (options.allowConnections !== undefined) {
        await client.query(
          `ALTER DATABASE ${quotedDb} WITH ALLOW_CONNECTIONS ${options.allowConnections}`,
        );
      }
      if (options.connectionLimit !== undefined) {
        await client.query(
          `ALTER DATABASE ${quotedDb} WITH CONNECTION LIMIT ${options.connectionLimit}`,
        );
      }
      for (const [param, value] of Object.entries(options.settings ?? {})) {
        await client.query(
          `ALTER DATABASE ${quotedDb} SET ${quoteGucIdentifier(param)} TO ${escapeLiteral(String(value))}`,
        );
      }
      for (const param of options.resetSettings ?? []) {
        await client.query(`ALTER DATABASE ${quotedDb} RESET ${quoteGucIdentifier(param)}`);
      }
      if (await getPostgresDatabaseOid(currentDbName, client) !== databaseOid) {
        throw new DatabaseError("Database identity changed during maintenance", "DATABASE_IN_USE");
      }
    });
  } catch (err) {
    const mapped = toDatabaseError(
      err,
      `Failed to apply database changes to '${databaseName}'`,
    );
    if (mapped) throw mapped;
    throw err;
  }

  if (renamed && jsondb) {
    try {
      await jsondb.update((current) => {
        const apiKeys = { ...(current.apiKeys ?? {}) };
        for (const [hash, record] of Object.entries(apiKeys)) {
          if (!record.databases.includes(databaseName)) continue;
          const bindings = record.databaseOids ?? {};
          const boundOid = Object.hasOwn(bindings, databaseName) ? bindings[databaseName] : undefined;
          if (boundOid && boundOid !== databaseOid) continue;
          const nextBindings = withoutDatabases(bindings, databaseName);
          apiKeys[hash] = {
            ...record,
            databases: [...new Set(record.databases.map((name) => name === databaseName ? currentDbName : name))],
            databaseOids: boundOid ? { ...nextBindings, [currentDbName]: boundOid } : nextBindings,
            ...(record.databaseScopes && {
              databaseScopes: renameDatabaseScope(record.databaseScopes, databaseName, currentDbName),
            }),
            ...(record.accessScopes && {
              accessScopes: renameDatabaseScope(record.accessScopes, databaseName, currentDbName),
            }),
          };
        }
        return { ...current, apiKeys };
      });
    } catch {
      throw new DatabaseError(
        `Database renamed from '${databaseName}' to '${currentDbName}', but updating its API-key scopes failed`,
        "PARTIAL_RENAME_METADATA_SYNC_FAILED",
      );
    }
  }

  return { database: currentDbName, renamed };
}

/**
 * Deletes an existing PostgreSQL database. Protected databases are disallowed.
 */
export async function deletePostgresDatabase(
  databaseName: string,
  pool?: Pool,
  force = false,
  jsondb?: JsonDB,
): Promise<void> {
  if (!isValidDatabaseName(databaseName)) {
    throw new DatabaseError(
      `Invalid database name: '${databaseName}'`,
      "INVALID_DATABASE_NAME",
    );
  }

  if (SYSTEM_DATABASES.has(databaseName.toLowerCase())) {
    throw new DatabaseError(
      `Cannot delete protected system database: '${databaseName}'`,
      "PROTECTED_DATABASE",
    );
  }

  const pg = requireDatabasePool(pool);

  const databaseOid = await getPostgresDatabaseOid(databaseName, pg);
  if (!databaseOid) {
    throw new DatabaseError(
      `Database '${databaseName}' does not exist`,
      "DATABASE_NOT_FOUND",
    );
  }

  const quoted = quoteIdentifier(databaseName);
  const sql = force
    ? `DROP DATABASE ${quoted} WITH (FORCE)`
    : `DROP DATABASE ${quoted}`;

  try {
    await pg.query(sql);
  } catch (err) {
    const mapped = toDatabaseError(
      err,
      `Failed to delete database '${databaseName}'`,
    );
    if (mapped) throw mapped;
    throw err;
  }

  if (jsondb) {
    try {
      await jsondb.update((current) => {
        const apiKeys = { ...(current.apiKeys ?? {}) };
        for (const [keyHash, record] of Object.entries(apiKeys)) {
          if (!record.databases.includes(databaseName)) continue;
          const bindings = record.databaseOids ?? {};
          const boundOid = Object.hasOwn(bindings, databaseName) ? bindings[databaseName] : undefined;
          if (boundOid && boundOid !== databaseOid) continue;
          apiKeys[keyHash] = {
            ...record,
            databases: record.databases.filter((name) => name !== databaseName),
            databaseOids: withoutDatabases(bindings, databaseName),
            ...(record.databaseScopes && {
              databaseScopes: withoutDatabases(record.databaseScopes, databaseName),
            }),
            ...(record.accessScopes && {
              accessScopes: withoutDatabases(record.accessScopes, databaseName),
            }),
          };
        }
        return { ...current, apiKeys };
      });
    } catch (err) {
      throw new DatabaseError(
        `Database '${databaseName}' was dropped, but updating JsonDB API key references failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "PARTIAL_DELETE_METADATA_SYNC_FAILED",
      );
    }
  }
}
