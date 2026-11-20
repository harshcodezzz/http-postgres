import { escapeLiteral, Pool, type PoolClient } from "pg";
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

let defaultPgPool: Pool | null = null;

function withoutDatabases<T>(entries: Record<string, T>, ...names: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([name]) => !names.includes(name)));
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

function quoteIdentifier(identifier: string): string {
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

export function getDatabasePool(): Pool {
  if (!defaultPgPool) {
    defaultPgPool = new Pool({
      connectionString: config.database.url,
      min: 1,
      max: 5,
      idleTimeoutMillis: 10_000,
    });
    defaultPgPool.on("error", (err) => {
      console.error("Unexpected error on idle PostgreSQL client in pool", err);
    });
  }
  return defaultPgPool;
}

export async function closeDatabasePool(): Promise<void> {
  if (defaultPgPool) {
    const pool = defaultPgPool;
    defaultPgPool = null;
    await pool.end();
  }
}

/**
 * Validates whether a database name complies with PostgreSQL identifier rules.
 */
export function isValidDatabaseName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 63) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(name);
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
  if (!isValidDatabaseName(databaseName)) {
    return undefined;
  }

  const pg = pool ?? getDatabasePool();

  try {
    const { rows } = await pg.query<{ oid: string }>(
      "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname = $1 AND NOT datistemplate",
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
 * Lists all accessible non-template databases from PostgreSQL.
 */
export async function listPostgresDatabases(pool?: Pool): Promise<string[]> {
  const pg = pool ?? getDatabasePool();
  try {
    const res = await pg.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
    );
    return res.rows.map((r) => r.datname);
  } catch (err: unknown) {
    const mapped = toDatabaseError(err, "Failed to list PostgreSQL databases");
    if (mapped) throw mapped;
    throw err;
  }
}

export interface PostgresDatabaseDetails {
  name: string;
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
): Promise<PostgresDatabaseDetails | null> {
  if (!isValidDatabaseName(databaseName)) {
    return null;
  }

  const pg = pool ?? getDatabasePool();

  try {
    const res = await pg.query<{
      datname: string;
      owner: string;
      encoding: string;
      lc_collate: string;
      lc_ctype: string;
      connection_limit: number;
      allow_connections: boolean;
      size_bytes?: string;
      size_pretty?: string;
    }>(
      `SELECT
        d.datname,
        pg_catalog.pg_get_userbyid(d.datdba) AS owner,
        pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
        d.datcollate AS lc_collate,
        d.datctype AS lc_ctype,
        d.datconnlimit AS connection_limit,
        d.datallowconn AS allow_connections,
        pg_catalog.pg_database_size(d.datname)::text AS size_bytes,
        pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname)) AS size_pretty
      FROM pg_catalog.pg_database d
      WHERE d.datname = $1 AND d.datistemplate = false`,
      [databaseName],
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
      name: row.datname,
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

  const pg = pool ?? getDatabasePool();

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
): Promise<{ database: string; renamed: boolean }> {
  if (!isValidDatabaseName(databaseName)) {
    throw new DatabaseError(
      `Invalid database name: '${databaseName}'`,
      "INVALID_DATABASE_NAME",
    );
  }

  const pg = pool ?? getDatabasePool();

  const databaseOid = await getPostgresDatabaseOid(databaseName, pg);
  if (!databaseOid) {
    throw new DatabaseError(
      `Database '${databaseName}' does not exist`,
      "DATABASE_NOT_FOUND",
    );
  }

  const isProtected = SYSTEM_DATABASES.has(databaseName.toLowerCase());

  // Upfront validation for all fields and system-database restrictions
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
          const privilegeMap = record.databaseScopes;
          const scopes = privilegeMap && Object.hasOwn(privilegeMap, databaseName)
            ? privilegeMap[databaseName]
            : undefined;
          apiKeys[hash] = {
            ...record,
            databases: [...new Set(record.databases.map((name) => name === databaseName ? currentDbName : name))],
            databaseOids: boundOid ? { ...nextBindings, [currentDbName]: boundOid } : nextBindings,
            ...(privilegeMap && {
              databaseScopes: {
                ...withoutDatabases(privilegeMap, databaseName, currentDbName),
                ...(scopes && { [currentDbName]: scopes }),
              },
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

  const pg = pool ?? getDatabasePool();

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
