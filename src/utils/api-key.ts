import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import config from "../config/index.js";
import { crudList, type DatabaseAccess, type TableName } from "../config/query-privileges.js";
import { provisionQueryAccess, queryAccess, type QueryAccess } from "./query-access.js";
import { appendAuditLine } from "./log-files.js";
import {
  JsonDB,
  type ApiKeyRecord,
  type DataStore,
} from "../plugins/jsondb.js";
import {
  isValidDatabaseName,
  checkDatabaseExists,
  getPostgresDatabaseOid,
  listPostgresDatabases,
  getPostgresDatabaseDetails,
  createPostgresDatabase,
  alterPostgresDatabase,
  deletePostgresDatabase,
  closeDatabasePool,
  SYSTEM_DATABASES,
  DatabaseError,
  type CreatePostgresDatabaseOptions,
  type PostgresDatabaseDetails,
  type AlterPostgresDatabaseOptions,
} from "./pg-database.js";

export {
  isValidDatabaseName,
  checkDatabaseExists,
  listPostgresDatabases,
  getPostgresDatabaseDetails,
  createPostgresDatabase,
  alterPostgresDatabase,
  deletePostgresDatabase,
  SYSTEM_DATABASES,
  DatabaseError,
  type CreatePostgresDatabaseOptions,
  type PostgresDatabaseDetails,
  type AlterPostgresDatabaseOptions,
};

export { ApiKeyRecord };

export type ApiKeyEnvironment = "LIVE" | "TEST";
export type ApiKeyStatus = "active" | "revoked";

export type VerifyApiKeyError =
  | "INVALID_FORMAT"
  | "INVALID_DATABASE_NAME"
  | "KEY_NOT_FOUND"
  | "KEY_REVOKED"
  | "DATABASE_MISMATCH"
  | "DATABASE_SCOPE_UNBOUND"
  | "ENVIRONMENT_MISMATCH";

export class ApiKeyError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "ApiKeyError";
  }
}

const API_KEY_LOG_FILE = resolve(process.cwd(), "logs", "api-keys.log");

const pendingLastUsedWrites = new Set<string>();

let sharedPgPool: Pool | null = null;

export function getApiKeyPool(): Pool {
  if (!sharedPgPool) {
    sharedPgPool = new Pool({
      connectionString: config.database.url,
      min: 1,
      max: 5,
      idleTimeoutMillis: 10_000,
    });
    sharedPgPool.on("error", () => {});
  }
  return sharedPgPool;
}

export async function closeApiKeyPool(): Promise<void> {
  if (sharedPgPool) {
    const pool = sharedPgPool;
    sharedPgPool = null;
    await pool.end();
  }
  await closeDatabasePool();
}

export interface ApiKeyAuditLog {
  timestamp: string;
  action: "CREATE" | "REVOKE" | "DELETE" | "VERIFY_FAILED" | "UPDATE_SCOPE";
  database: string;
  keyPrefix?: string;
  keyId?: string;
  environment?: ApiKeyEnvironment;
  success: boolean;
  reason?: string;
}

export interface ApiKeyScopeInput {
  databases?: unknown;
  database?: unknown;
  tables?: unknown;
  "scope-database"?: unknown;
  "scope-table"?: unknown;
}

export interface CreateApiKeyOptions extends ApiKeyScopeInput {
  environment?: ApiKeyEnvironment;
  db?: JsonDB;
  pgPool?: Pool;
  auditLogPath?: string;
}

export interface CreateApiKeyResult {
  apiKey: string;
  record: ApiKeyRecord;
}

export interface VerifyApiKeyResult {
  valid: boolean;
  record?: ApiKeyRecord;
  databaseOid?: string;
  access?: QueryAccess;
  error?: VerifyApiKeyError;
}

export interface VerifyApiKeyOptions {
  db?: JsonDB;
  auditLogPath?: string;
}

export interface DeleteApiKeyOptions {
  hardDelete?: boolean;
  auditLogPath?: string;
}

export interface UpdateApiKeyScopeOptions extends ApiKeyScopeInput {
  db?: JsonDB;
  pgPool?: Pool;
  auditLogPath?: string;
}

export function parseApiKey(apiKey: string): {
  environment: ApiKeyEnvironment;
  secret: string;
} | null {
  if (typeof apiKey !== "string") return null;
  const match = /^KEY_(LIVE|TEST)_([A-Za-z0-9_-]{16,})$/.exec(apiKey);
  if (!match) return null;

  return {
    environment: match[1] as ApiKeyEnvironment,
    secret: match[2],
  };
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function maskApiKey(apiKey: string): string {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return "INVALID_KEY";

  const { environment, secret } = parsed;
  return `KEY_${environment}_${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export async function writeAuditLog(
  entry: ApiKeyAuditLog,
  logPath = API_KEY_LOG_FILE,
): Promise<void> {
  const database = entry.database.length > 2_048 ? entry.database.slice(0, 2_048) + "…" : entry.database;
  await appendAuditLine(logPath, JSON.stringify({ ...entry, database }) + "\n");
}

function parseDatabaseTargets(input: ApiKeyScopeInput) {
  const { database, databases, tables, "scope-database": databaseScope, "scope-table": tableScope } = input;
  if (database !== undefined && databases !== undefined) {
    throw new ApiKeyError("Use either 'database' or 'databases'", "INVALID_DATABASE_SCOPE");
  }
  const assignments = database ?? databases;
  const names = Array.isArray(assignments) ? [...new Set<unknown>(assignments)] :
    typeof assignments === "string" ? [assignments] : [];
  if (names.length === 0) {
    throw new ApiKeyError("Provide a nonempty array of database names", "INVALID_DATABASE_SCOPE");
  }
  if (!Array.isArray(database) && tables === undefined && databaseScope === undefined && tableScope === undefined) {
    return { names };
  }

  const parsedDatabase = crudList.safeParse(databaseScope === undefined ? [] : databaseScope);
  const parsedTable = crudList.safeParse(tableScope === undefined ? [] : tableScope);
  if (!parsedDatabase.success || !parsedTable.success || (tables !== undefined && !Array.isArray(tables))) {
    throw new ApiKeyError("Use arrays for tables and CRUD scopes. Allowed operations are c, r, u, and d", "INVALID_DATABASE_SCOPE");
  }
  const tablesByDatabase = new Map<unknown, TableName[]>();
  function validIdentifier(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 63;
  }
  for (const value of tables ?? []) {
    const entry = typeof value === "string"
      ? (value.includes(".") ? value.split(".") : ["public", value])
      : undefined;
    const table = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const target = table?.database ?? (names.length === 1 ? names[0] : undefined);
    const schema = entry?.[0] ?? table?.schema ?? "public";
    const name = entry?.[1] ?? table?.name;
    if ((entry && entry.length !== 2) || !names.includes(target) || !validIdentifier(schema) || !validIdentifier(name)) {
      throw new ApiKeyError(
        "Use 'schema.table' for a single database or {database, schema, name} for multiple databases",
        "INVALID_TABLE_SCOPE",
      );
    }
    const selected = tablesByDatabase.get(target) ?? [];
    if (!selected.some((table) => table.schema === schema && table.name === name)) selected.push({ schema, name });
    tablesByDatabase.set(target, selected);
  }
  if (Boolean(tablesByDatabase.size) !== Boolean(parsedTable.data.length) ||
      (!parsedDatabase.data.length && names.some((name) => !tablesByDatabase.has(name)))) {
    throw new ApiKeyError("Assign at least one operation to every database and pair 'tables' with 'scope-table'", "INVALID_DATABASE_SCOPE");
  }

  const policies = new Map(names.map((name) => [name, {
    database: parsedDatabase.data,
    tables: tablesByDatabase.get(name) ?? [],
    table: parsedTable.data,
  }]));
  return { names, policies };
}

async function provisionScopes(
  targets: ReturnType<typeof parseDatabaseTargets>,
  bindings: [string, string][],
  db: JsonDB,
  pgPool?: Pool,
) {
  const { policies } = targets;
  if (!policies) return;
  const secret = (await db.read<DataStore>()).queryRoleSecret ??
    (await db.update<DataStore>((current) => current.queryRoleSecret ? current : {
      ...current, queryRoleSecret: randomBytes(32).toString("base64url"),
    })).queryRoleSecret;
  if (!secret) throw new Error("Could not initialize PostgreSQL role credentials");

  const scopes: [string, DatabaseAccess][] = [];
  for (const [database, oid] of bindings) {
    const policy = policies.get(database);
    if (!policy) throw new Error("Missing database scope");
    const scope = await provisionQueryAccess(database, oid, policy, secret, pgPool ?? getApiKeyPool());
    scopes.push([database, scope]);
  }
  return Object.fromEntries(scopes);
}

/**
 * Creates a new API key scoped to one or more databases and persists it to JsonDB.
 * Validates that all databases exist in PostgreSQL before creation.
 */
export async function createApiKey(
  options: CreateApiKeyOptions,
): Promise<CreateApiKeyResult> {
  const { environment = "LIVE" } = options;
  if (environment !== "LIVE" && environment !== "TEST") {
    throw new ApiKeyError(
      "Environment must be 'LIVE' or 'TEST'",
      "INVALID_ENVIRONMENT",
    );
  }

  const targets = parseDatabaseTargets(options);
  const db = options.db ?? new JsonDB();
  const auditPath = options.auditLogPath ?? API_KEY_LOG_FILE;

  const bindings: [string, string][] = [];
  for (const database of targets.names) {
    if (!isValidDatabaseName(database)) {
      await writeAuditLog(
        {
          timestamp: new Date().toISOString(),
          action: "CREATE",
          database: typeof database === "string" ? database : "invalid",
          environment,
          success: false,
          reason: "INVALID_DATABASE_NAME",
        },
        auditPath,
      );
      throw new ApiKeyError(
        typeof database === "string" ? `Invalid database name: '${database}'` : "Database names must be strings",
        "INVALID_DATABASE_NAME",
      );
    }

    const oid = await getPostgresDatabaseOid(database, options.pgPool);
    if (!oid) {
      await writeAuditLog(
        {
          timestamp: new Date().toISOString(),
          action: "CREATE",
          database,
          environment,
          success: false,
          reason: "DATABASE_NOT_FOUND",
        },
        auditPath,
      );

      throw new ApiKeyError(
        `Database '${database}' does not exist in PostgreSQL`,
        "DATABASE_NOT_FOUND",
      );
    }
    bindings.push([database, oid]);
  }

  const accessScopes = await provisionScopes(targets, bindings, db, options.pgPool);
  const secret = randomBytes(24).toString("base64url");
  const apiKey = `KEY_${environment}_${secret}`;
  const keyHash = hashApiKeySecret(secret);
  const keyPrefix = maskApiKey(apiKey);
  const id = randomBytes(12).toString("hex");

  const record: ApiKeyRecord = {
    id,
    keyHash,
    keyPrefix,
    databases: bindings.map(([database]) => database),
    databaseOids: Object.fromEntries(bindings),
    ...(accessScopes && { accessScopes }),
    environment,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  await db.update((current) => {
    const existing = { ...(current.apiKeys ?? {}) };
    return {
      ...current,
      apiKeys: {
        ...existing,
        [keyHash]: record,
      },
    };
  });

  await writeAuditLog(
    {
      timestamp: new Date().toISOString(),
      action: "CREATE",
      database: record.databases.join(", "),
      keyId: id,
      keyPrefix,
      environment,
      success: true,
    },
    auditPath,
  );

  return { apiKey, record };
}

/**
 * Verifies an API key against a target database name.
 * The key is valid if the target database is in the key's databases list.
 * Does not synchronously write to JSONDB on every request.
 * Does not append audit logs for successful verifications.
 */
export async function verifyApiKey(
  databaseName: string,
  apiKey: string,
  dbOrOptions?: JsonDB | VerifyApiKeyOptions,
): Promise<VerifyApiKeyResult> {
  const db =
    dbOrOptions instanceof JsonDB
      ? dbOrOptions
      : (dbOrOptions?.db ?? new JsonDB());
  const auditPath =
    dbOrOptions instanceof JsonDB
      ? API_KEY_LOG_FILE
      : (dbOrOptions?.auditLogPath ?? API_KEY_LOG_FILE);

  if (!isValidDatabaseName(databaseName)) {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: typeof databaseName === "string" ? databaseName : "invalid",
        success: false,
        reason: "INVALID_DATABASE_NAME",
      },
      auditPath,
    );
    return { valid: false, error: "INVALID_DATABASE_NAME" };
  }

  const parsed = parseApiKey(apiKey);
  if (!parsed) {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: databaseName,
        success: false,
        reason: "INVALID_FORMAT",
      },
      auditPath,
    );
    return { valid: false, error: "INVALID_FORMAT" };
  }

  const keyHash = hashApiKeySecret(parsed.secret);
  const data = await db.read<DataStore>();
  const record = data.apiKeys?.[keyHash];

  if (!record) {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: databaseName,
        keyPrefix: maskApiKey(apiKey),
        environment: parsed.environment,
        success: false,
        reason: "KEY_NOT_FOUND",
      },
      auditPath,
    );
    return { valid: false, error: "KEY_NOT_FOUND" };
  }

  if (record.environment !== parsed.environment) {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: databaseName,
        keyId: record.id,
        keyPrefix: record.keyPrefix,
        environment: parsed.environment,
        success: false,
        reason: "ENVIRONMENT_MISMATCH",
      },
      auditPath,
    );
    return { valid: false, record, error: "ENVIRONMENT_MISMATCH" };
  }

  if (record.status !== "active") {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: databaseName,
        keyId: record.id,
        keyPrefix: record.keyPrefix,
        environment: record.environment,
        success: false,
        reason: "KEY_REVOKED",
      },
      auditPath,
    );
    return { valid: false, record, error: "KEY_REVOKED" };
  }

  if (!record.databases.includes(databaseName)) {
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "VERIFY_FAILED",
        database: databaseName,
        keyId: record.id,
        keyPrefix: record.keyPrefix,
        environment: record.environment,
        success: false,
        reason: "DATABASE_MISMATCH",
      },
      auditPath,
    );
    return { valid: false, record, error: "DATABASE_MISMATCH" };
  }

  const databaseOid = record.databaseOids && Object.hasOwn(record.databaseOids, databaseName)
    ? record.databaseOids[databaseName]
    : undefined;
  if (!databaseOid) return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };

  if (record.databaseScopes !== undefined) return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };
  let access: QueryAccess | undefined;
  if (record.accessScopes !== undefined) {
    const scope = Object.hasOwn(record.accessScopes, databaseName) ? record.accessScopes[databaseName] : undefined;
    if (!scope?.roleToken || !data.queryRoleSecret) return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };
    access = {
      ...queryAccess(data.queryRoleSecret, scope.roleToken),
      readOnly: scope.database.every((operation) => operation === "r") &&
        (!scope.tables.length || scope.table.every((operation) => operation === "r")),
    };
  }

  const now = Date.now();
  const lastUsed = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if ((!lastUsed || now - lastUsed >= 60_000) && !pendingLastUsedWrites.has(keyHash)) {
    pendingLastUsedWrites.add(keyHash);
    void db.update((current) => {
      const currentRecord = current.apiKeys?.[keyHash];
      const currentLastUsed = Date.parse(currentRecord?.lastUsedAt ?? "") || 0;
      if (currentRecord?.status !== "active" || (currentLastUsed && now - currentLastUsed < 60_000)) {
        return current;
      }
      return {
        ...current,
        apiKeys: {
          ...current.apiKeys,
          [keyHash]: { ...currentRecord, lastUsedAt: new Date(now).toISOString() },
        },
      };
    }).catch(() => {}).finally(() => pendingLastUsedWrites.delete(keyHash));
  }

  return { valid: true, record, databaseOid, access };
}

/**
 * Revokes an API key (status: "revoked") in JsonDB.
 */
export async function revokeApiKey(
  apiKeyOrId: string,
  db: JsonDB = new JsonDB(),
  auditLogPath = API_KEY_LOG_FILE,
): Promise<boolean> {
  const parsed = parseApiKey(apiKeyOrId);
  const keyHash = parsed ? hashApiKeySecret(parsed.secret) : null;
  let revokedRecord: ApiKeyRecord | null = null;

  await db.update((current) => {
    const apiKeys = { ...(current.apiKeys ?? {}) };

    if (keyHash && apiKeys[keyHash]) {
      apiKeys[keyHash] = {
        ...apiKeys[keyHash],
        status: "revoked",
        revokedAt: new Date().toISOString(),
      };
      revokedRecord = apiKeys[keyHash];
    } else {
      const entry = Object.entries(apiKeys).find(
        ([, r]) => r.id === apiKeyOrId,
      );
      if (entry) {
        apiKeys[entry[0]] = {
          ...entry[1],
          status: "revoked",
          revokedAt: new Date().toISOString(),
        };
        revokedRecord = apiKeys[entry[0]];
      }
    }

    return {
      ...current,
      apiKeys,
    };
  });

  const success = revokedRecord !== null;

  if (revokedRecord) {
    const rec = revokedRecord as ApiKeyRecord;
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "REVOKE",
        database: rec.databases.join(", "),
        keyId: rec.id,
        keyPrefix: rec.keyPrefix,
        environment: rec.environment,
        success: true,
      },
      auditLogPath,
    );
  }

  return success;
}

/**
 * Updates the database scope of an existing API key.
 * Requires at least one database. Validates all databases exist in PostgreSQL.
 */
export async function updateApiKeyScope(
  apiKeyOrId: string,
  options: UpdateApiKeyScopeOptions,
): Promise<ApiKeyRecord> {
  const targets = parseDatabaseTargets(options);
  const db = options.db ?? new JsonDB();
  const auditPath = options.auditLogPath ?? API_KEY_LOG_FILE;

  const parsed = parseApiKey(apiKeyOrId);
  const keyHash = parsed ? hashApiKeySecret(parsed.secret) : null;
  const current = await db.read<DataStore>();
  const record = keyHash ? current.apiKeys?.[keyHash] :
    Object.values(current.apiKeys ?? {}).find((entry) => entry.id === apiKeyOrId);
  if (record?.status !== "active") throw new ApiKeyError("API key not found or is not active", "KEY_NOT_FOUND");
  if ((record.databaseScopes !== undefined || record.accessScopes !== undefined) && !targets.policies) {
    throw new ApiKeyError("This key requires an explicit CRUD scope", "DATABASE_SCOPES_REQUIRED");
  }

  const bindings: [string, string][] = [];
  for (const database of targets.names) {
    if (!isValidDatabaseName(database)) {
      throw new ApiKeyError(
        typeof database === "string" ? `Invalid database name: '${database}'` : "Database names must be strings",
        "INVALID_DATABASE_NAME",
      );
    }

    const oid = await getPostgresDatabaseOid(database, options.pgPool);
    if (!oid) {
      throw new ApiKeyError(
        `Database '${database}' does not exist in PostgreSQL`,
        "DATABASE_NOT_FOUND",
      );
    }
    bindings.push([database, oid]);
  }

  let updatedRecord: ApiKeyRecord | null = null;

  const accessScopes = await provisionScopes(targets, bindings, db, options.pgPool);

  await db.update((current) => {
    const apiKeys = { ...(current.apiKeys ?? {}) };
    let targetHash: string | null = null;

    if (keyHash && apiKeys[keyHash]) {
      targetHash = keyHash;
    } else {
      const entry = Object.entries(apiKeys).find(
        ([, r]) => r.id === apiKeyOrId,
      );
      if (entry) {
        targetHash = entry[0];
      }
    }

    if (!targetHash || !apiKeys[targetHash]) {
      return current;
    }

    if (apiKeys[targetHash].status !== "active") {
      return current;
    }
    const record = apiKeys[targetHash];
    if ((record.databaseScopes !== undefined || record.accessScopes !== undefined) && !accessScopes) {
      throw new ApiKeyError("This key requires an explicit CRUD scope", "DATABASE_SCOPES_REQUIRED");
    }

    const updated = {
      ...record,
      databases: bindings.map(([database]) => database),
      databaseOids: Object.fromEntries(bindings),
      ...(accessScopes && { accessScopes }),
    };
    delete updated.databaseScopes;
    apiKeys[targetHash] = updated;
    updatedRecord = apiKeys[targetHash];

    return {
      ...current,
      apiKeys,
    };
  });

  if (!updatedRecord) {
    throw new ApiKeyError(
      "API key not found or is not active",
      "KEY_NOT_FOUND",
    );
  }

  const rec = updatedRecord as ApiKeyRecord;
  await writeAuditLog(
    {
      timestamp: new Date().toISOString(),
      action: "UPDATE_SCOPE",
      database: rec.databases.join(", "),
      keyId: rec.id,
      keyPrefix: rec.keyPrefix,
      environment: rec.environment,
      success: true,
    },
    auditPath,
  );

  return rec;
}

/**
 * Deletes or revokes an API key from JsonDB.
 * Defaults to soft-revocation so key history is preserved. Pass hardDelete: true for removal.
 */
export async function deleteApiKey(
  apiKeyOrId: string,
  db: JsonDB = new JsonDB(),
  options?: DeleteApiKeyOptions,
): Promise<boolean> {
  const auditPath = options?.auditLogPath ?? API_KEY_LOG_FILE;

  if (!options?.hardDelete) {
    return revokeApiKey(apiKeyOrId, db, auditPath);
  }

  const parsed = parseApiKey(apiKeyOrId);
  const keyHash = parsed ? hashApiKeySecret(parsed.secret) : null;
  let deletedRecord: ApiKeyRecord | null = null;

  await db.update((current) => {
    const apiKeys = { ...(current.apiKeys ?? {}) };

    if (keyHash && apiKeys[keyHash]) {
      deletedRecord = apiKeys[keyHash];
      delete apiKeys[keyHash];
    } else {
      const entry = Object.entries(apiKeys).find(
        ([, r]) => r.id === apiKeyOrId,
      );
      if (entry) {
        deletedRecord = entry[1];
        delete apiKeys[entry[0]];
      }
    }

    return {
      ...current,
      apiKeys,
    };
  });

  const success = deletedRecord !== null;

  if (deletedRecord) {
    const rec = deletedRecord as ApiKeyRecord;
    await writeAuditLog(
      {
        timestamp: new Date().toISOString(),
        action: "DELETE",
        database: rec.databases.join(", "),
        keyId: rec.id,
        keyPrefix: rec.keyPrefix,
        environment: rec.environment,
        success: true,
      },
      auditPath,
    );
  }

  return success;
}

/**
 * Lists all API key records from JsonDB.
 */
export async function listApiKeys(
  db: JsonDB = new JsonDB(),
): Promise<ApiKeyRecord[]> {
  const data = await db.read<DataStore>();
  return Object.values(data.apiKeys ?? {});
}

/**
 * Retrieves a single API key record by its ID.
 */
export async function getApiKeyById(
  id: string,
  db: JsonDB = new JsonDB(),
): Promise<ApiKeyRecord | null> {
  const data = await db.read<DataStore>();
  const record = Object.values(data.apiKeys ?? {}).find((r) => r.id === id);
  return record ?? null;
}
