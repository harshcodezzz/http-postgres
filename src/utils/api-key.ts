import { randomBytes, createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Pool } from "pg";
import config from "../config/index.js";
import { JsonDB, type ApiKeyRecord, type DataStore } from "../plugins/jsondb.js";

export { ApiKeyRecord };

export type ApiKeyEnvironment = "LIVE" | "TEST";
export type ApiKeyStatus = "active" | "revoked";

export type VerifyApiKeyError =
  | "INVALID_FORMAT"
  | "INVALID_DATABASE_NAME"
  | "KEY_NOT_FOUND"
  | "KEY_REVOKED"
  | "DATABASE_MISMATCH"
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

// In-memory throttle for updating lastUsedAt: keyHash -> timestamp
const lastUsedThrottleMap = new Map<string, number>();

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
 * Distinguishes between database not found and insufficient permissions.
 */
export async function checkDatabaseExists(
  databaseName: string,
  pool?: Pool,
): Promise<boolean> {
  if (!isValidDatabaseName(databaseName)) {
    return false;
  }

  const pg = pool ?? getApiKeyPool();

  try {
    const res = await pg.query(
      "SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate = false",
      [databaseName],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr && pgErr.code === "42501") {
      throw new ApiKeyError(
        "Insufficient privileges to verify database in pg_database",
        "INSUFFICIENT_PRIVILEGE",
      );
    }
    throw err;
  }
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

export interface CreateApiKeyOptions {
  databases?: string[];
  database?: string;
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

export interface UpdateApiKeyScopeOptions {
  databases: string[];
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
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Audit logging failures must never break API key operations
  }
}

/**
 * Creates a new API key scoped to one or more databases and persists it to JsonDB.
 * Validates that all databases exist in PostgreSQL before creation.
 */
export async function createApiKey(
  options: CreateApiKeyOptions,
): Promise<CreateApiKeyResult> {
  const { environment = "LIVE" } = options;
  const rawDatabases = options.databases ?? (options.database ? [options.database] : []);
  const databases = [...new Set(rawDatabases)];
  const db = options.db ?? new JsonDB();
  const auditPath = options.auditLogPath ?? API_KEY_LOG_FILE;

  if (databases.length === 0) {
    throw new ApiKeyError(
      "At least one database is required",
      "INVALID_DATABASE_NAME",
    );
  }

  for (const database of databases) {
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
        `Invalid database name: '${database}'`,
        "INVALID_DATABASE_NAME",
      );
    }

    const dbExists = await checkDatabaseExists(database, options.pgPool);
    if (!dbExists) {
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
  }

  const secret = randomBytes(24).toString("base64url");
  const apiKey = `KEY_${environment}_${secret}`;
  const keyHash = hashApiKeySecret(secret);
  const keyPrefix = maskApiKey(apiKey);
  const id = randomBytes(12).toString("hex");

  const record: ApiKeyRecord = {
    id,
    keyHash,
    keyPrefix,
    databases,
    environment,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  lastUsedThrottleMap.set(keyHash, Date.now());

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
      database: databases.join(", "),
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

  // Update lastUsedAt at most once per 60 seconds per key, without blocking request
  const now = Date.now();
  const lastRecorded = lastUsedThrottleMap.get(keyHash);
  const baseline =
    lastRecorded ??
    (record.lastUsedAt ? new Date(record.lastUsedAt).getTime() : 0);

  if (lastRecorded === undefined) {
    lastUsedThrottleMap.set(keyHash, baseline);
  }

  if (now - baseline >= 60_000) {
    lastUsedThrottleMap.set(keyHash, now);
    Promise.resolve().then(() => {
      db.update((current) => {
        const keys = { ...(current.apiKeys ?? {}) };
        if (keys[keyHash] && keys[keyHash].status === "active") {
          keys[keyHash] = {
            ...keys[keyHash],
            lastUsedAt: new Date(now).toISOString(),
          };
        }
        return {
          ...current,
          apiKeys: keys,
        };
      }).catch(() => {});
    });
  }

  return { valid: true, record };
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
      const entry = Object.entries(apiKeys).find(([, r]) => r.id === apiKeyOrId);
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
  const { databases } = options;
  const db = options.db ?? new JsonDB();
  const auditPath = options.auditLogPath ?? API_KEY_LOG_FILE;

  if (!Array.isArray(databases) || databases.length === 0) {
    throw new ApiKeyError(
      "At least one database is required",
      "INVALID_DATABASE_NAME",
    );
  }

  for (const database of databases) {
    if (!isValidDatabaseName(database)) {
      throw new ApiKeyError(
        `Invalid database name: '${database}'`,
        "INVALID_DATABASE_NAME",
      );
    }

    const dbExists = await checkDatabaseExists(database, options.pgPool);
    if (!dbExists) {
      throw new ApiKeyError(
        `Database '${database}' does not exist in PostgreSQL`,
        "DATABASE_NOT_FOUND",
      );
    }
  }

  const parsed = parseApiKey(apiKeyOrId);
  const keyHash = parsed ? hashApiKeySecret(parsed.secret) : null;
  let updatedRecord: ApiKeyRecord | null = null;

  await db.update((current) => {
    const apiKeys = { ...(current.apiKeys ?? {}) };
    let targetHash: string | null = null;

    if (keyHash && apiKeys[keyHash]) {
      targetHash = keyHash;
    } else {
      const entry = Object.entries(apiKeys).find(([, r]) => r.id === apiKeyOrId);
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

    apiKeys[targetHash] = {
      ...apiKeys[targetHash],
      databases: [...new Set(databases)],
    };
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
      const entry = Object.entries(apiKeys).find(([, r]) => r.id === apiKeyOrId);
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
