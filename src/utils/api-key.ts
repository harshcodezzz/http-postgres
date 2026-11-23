import { randomBytes, randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { crudList, type DatabaseAccess, type TableName } from "../config/query-privileges.js";
import { deprovisionQueryAccess, isolateQueryAccess, provisionQueryAccess, queryAccess, type QueryAccess } from "./query-access.js";
import { appendAuditLine } from "./log-files.js";
import {
  hashApiKeySecret,
  maskApiKey,
  parseApiKey,
  type ApiKeyEnvironment,
} from "../services/api-key/crypto.js";
import {
  JsonDB,
  type ApiKeyRecord,
  type DataStore,
  type PendingRoleCleanup,
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

export type { ApiKeyEnvironment } from "../services/api-key/crypto.js";
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
const pendingScopeMigrations = new Map<string, Promise<DatabaseAccess | undefined>>();
const activeCleanupRuns = new Map<string, Promise<RoleCleanupStatus>>();
const provisioningCleanupDelayMs = 5 * 60_000;
const cleanupBatchSize = 10;
const cleanupLeaseMs = 60_000;
const cleanupRetryCapMs = 60 * 60_000;

export interface RoleCleanupStatus {
  pending: number;
  cleanups: Array<Omit<PendingRoleCleanup, "roleToken">>;
}

function cleanupId(database: string, roleToken: string) {
  return createHash("sha256").update(JSON.stringify([database, roleToken])).digest("hex");
}

function enqueueRoleCleanups(
  current: DataStore,
  keyId: string,
  scopes: Record<string, DatabaseAccess> | undefined,
  excludedTokens: ReadonlySet<string> = new Set(),
) {
  const pendingRoleCleanups = { ...(current.pendingRoleCleanups ?? {}) };
  const createdAt = new Date().toISOString();
  for (const [database, scope] of Object.entries(scopes ?? {})) {
    if (excludedTokens.has(scope.roleToken)) continue;
    const stillInUse = Object.values(current.apiKeys ?? {}).some((record) =>
      record.id !== keyId && record.status === "active" &&
      record.accessScopes?.[database]?.roleToken === scope.roleToken
    );
    if (stillInUse) continue;
    const id = cleanupId(database, scope.roleToken);
    pendingRoleCleanups[id] ??= {
      id, keyId, database, roleToken: scope.roleToken, createdAt, attempts: 0,
    };
  }
  return pendingRoleCleanups;
}

function removeRoleCleanups(
  pending: Record<string, PendingRoleCleanup> | undefined,
  scopes: Record<string, DatabaseAccess> | undefined,
) {
  const retained = { ...(pending ?? {}) };
  for (const [database, scope] of Object.entries(scopes ?? {})) {
    delete retained[cleanupId(database, scope.roleToken)];
  }
  return retained;
}

async function persistProvisioningIntent(db: JsonDB, keyId: string, database: string, roleToken: string) {
  const id = cleanupId(database, roleToken);
  await db.update<DataStore>((current) => {
    const existing = current.pendingRoleCleanups?.[id];
    if (existing?.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > Date.now()) {
      throw new Error("PostgreSQL role cleanup is already in progress; retry provisioning");
    }
    return {
      ...current,
      pendingRoleCleanups: {
        ...current.pendingRoleCleanups,
        [id]: {
          id,
          keyId,
          database,
          roleToken,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          cleanupAfter: new Date(Date.now() + provisioningCleanupDelayMs).toISOString(),
          attempts: existing?.attempts ?? 0,
        },
      },
    };
  });
}

function cleanupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

export async function getRoleCleanupStatus(db: JsonDB = new JsonDB()): Promise<RoleCleanupStatus> {
  const cleanups = (await db.listRoleCleanups()).map(({ roleToken: _roleToken, ...cleanup }) => cleanup);
  return { pending: cleanups.length, cleanups };
}

export function retryPendingRoleCleanups(
  db: JsonDB = new JsonDB(),
  pool?: Pool,
  force = false,
) {
  const runKey = db.filePath;
  const running = activeCleanupRuns.get(runKey);
  if (running) return running;
  const operation = (async () => {
    const secret = await db.get<string>("queryRoleSecret");
    if (!secret) return getRoleCleanupStatus(db);
    const leaseOwner = randomUUID();
    const now = Date.now();
    const claimed = await db.claimRoleCleanups(
      leaseOwner,
      new Date(now).toISOString(),
      new Date(now + cleanupLeaseMs).toISOString(),
      cleanupBatchSize,
      force,
    );
    for (const cleanup of claimed) {
      const attemptedAt = new Date().toISOString();
      try {
        if (await db.isRoleActive(cleanup.database, cleanup.roleToken)) {
          await db.completeRoleCleanup(cleanup.id, leaseOwner);
          continue;
        }
        await deprovisionQueryAccess(cleanup.database, cleanup.roleToken, secret, requirePool(pool));
        await db.completeRoleCleanup(cleanup.id, leaseOwner);
      } catch (error) {
        const attempts = cleanup.attempts + 1;
        const baseDelay = Math.min(cleanupRetryCapMs, 1_000 * 2 ** Math.min(attempts, 12));
        const delay = Math.floor(baseDelay * (0.75 + Math.random() * 0.5));
        await db.failRoleCleanup(cleanup.id, leaseOwner, attemptedAt,
          new Date(Date.now() + delay).toISOString(), cleanupError(error));
      }
    }
    return getRoleCleanupStatus(db);
  })().finally(() => activeCleanupRuns.delete(runKey));
  activeCleanupRuns.set(runKey, operation);
  return operation;
}

export function startRoleCleanupWorker(db: JsonDB, pool: Pool, log: FastifyBaseLogger) {
  let stopped = false;
  const retry = () => void retryPendingRoleCleanups(db, pool)
    .catch((error) => log.error({ err: error }, "Could not run PostgreSQL role cleanup scheduler"));
  retry();
  const timer = setInterval(retry, 5_000).unref();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await activeCleanupRuns.get(db.filePath);
  };
}

function requirePool(pool: Pool | undefined): Pool {
  if (!pool) throw new Error("An application-owned PostgreSQL pool is required");
  return pool;
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
  pgPool?: Pool;
  auditLogPath?: string;
}

export interface DeleteApiKeyOptions {
  hardDelete?: boolean;
  auditLogPath?: string;
  pgPool?: Pool;
}

export interface UpdateApiKeyScopeOptions extends ApiKeyScopeInput {
  db?: JsonDB;
  pgPool?: Pool;
  auditLogPath?: string;
}

export { hashApiKeySecret, maskApiKey, parseApiKey } from "../services/api-key/crypto.js";

export async function writeAuditLog(
  entry: ApiKeyAuditLog,
  logPath = API_KEY_LOG_FILE,
): Promise<void> {
  const database = entry.database.length > 2_048 ? entry.database.slice(0, 2_048) + "…" : entry.database;
  await appendAuditLine(logPath, JSON.stringify({ ...entry, database }) + "\n");
}

function parseDatabaseTargets(input: ApiKeyScopeInput, defaultToFullCrud = false) {
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
  const scopeOmitted = tables === undefined && databaseScope === undefined && tableScope === undefined;
  if (scopeOmitted && defaultToFullCrud) {
    const operations = crudList.parse(["c", "r", "u", "d"]);
    return {
      names,
      policies: new Map(names.map((name) => [name, {
        database: operations,
        tables: [] as TableName[],
        table: [],
      }])),
    };
  }
  if (!Array.isArray(database) && scopeOmitted) {
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
  owner: string,
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
    const scope = await provisionQueryAccess(
      database,
      oid,
      policy,
      secret,
      requirePool(pgPool),
      owner,
      (roleToken) => persistProvisioningIntent(db, owner, database, roleToken),
    );
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

  const targets = parseDatabaseTargets(options, true);
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

  const id = randomBytes(12).toString("hex");
  const accessScopes = await provisionScopes(targets, bindings, db, id, options.pgPool);
  const secret = randomBytes(24).toString("base64url");
  const apiKey = `KEY_${environment}_${secret}`;
  const keyHash = hashApiKeySecret(secret);
  const keyPrefix = maskApiKey(apiKey);

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
      pendingRoleCleanups: removeRoleCleanups(current.pendingRoleCleanups, accessScopes),
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

function migrateSharedScope(
  db: JsonDB, keyHash: string, record: ApiKeyRecord, database: string, oid: string,
  scope: DatabaseAccess, secret: string, pool?: Pool,
) {
  const migrationKey = JSON.stringify([db.filePath, record.id, oid, scope.roleToken]);
  const pending = pendingScopeMigrations.get(migrationKey);
  if (pending) return pending;

  const migration = (async () => {
    const isolated = await isolateQueryAccess(
      database,
      oid,
      scope,
      secret,
      requirePool(pool),
      record.id,
      (roleToken) => persistProvisioningIntent(db, record.id, database, roleToken),
    );
    const data = await db.update<DataStore>((current) => {
      const latest = current.apiKeys?.[keyHash];
      if (latest?.status !== "active" || latest.databaseOids?.[database] !== oid ||
          latest.accessScopes?.[database]?.roleToken !== scope.roleToken) return current;
      return {
        ...current,
        pendingRoleCleanups: removeRoleCleanups(current.pendingRoleCleanups, { [database]: isolated }),
        apiKeys: {
          ...current.apiKeys,
          [keyHash]: { ...latest, accessScopes: { ...latest.accessScopes, [database]: isolated } },
        },
      };
    });
    const latest = data.apiKeys?.[keyHash];
    if (latest?.status !== "active" || latest.databaseOids?.[database] !== oid) return;
    const updated = latest.accessScopes?.[database];
    if (updated?.roleOwner === record.id) return updated;
  })().finally(() => pendingScopeMigrations.delete(migrationKey));
  pendingScopeMigrations.set(migrationKey, migration);
  return migration;
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
  const [record, queryRoleSecret] = await Promise.all([
    db.findApiKey(keyHash),
    db.get<string>("queryRoleSecret"),
  ]);

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
    let scope = Object.hasOwn(record.accessScopes, databaseName) ? record.accessScopes[databaseName] : undefined;
    if (!scope?.roleToken || !queryRoleSecret) return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };
    if (scope.roleOwner !== record.id) {
      try {
        const pool = dbOrOptions instanceof JsonDB ? undefined : dbOrOptions?.pgPool;
        scope = await migrateSharedScope(db, keyHash, record, databaseName, databaseOid, scope, queryRoleSecret, pool);
      } catch (error) {
        if (error instanceof DatabaseError && error.code === "DATABASE_SCOPE_UNBOUND") {
          return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };
        }
        throw error;
      }
      if (!scope) return { valid: false, error: "DATABASE_SCOPE_UNBOUND" };
    }
    access = {
      ...queryAccess(queryRoleSecret, scope.roleToken),
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
  pgPool?: Pool,
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
      ...(revokedRecord && {
        pendingRoleCleanups: enqueueRoleCleanups(
          { ...current, apiKeys }, revokedRecord.id, revokedRecord.accessScopes,
        ),
      }),
    };
  });

  const success = revokedRecord !== null;

  if (revokedRecord) {
    const rec = revokedRecord as ApiKeyRecord;
    await retryPendingRoleCleanups(db, requirePool(pgPool), true);
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
  const previousScopes = record.accessScopes;

  const accessScopes = await provisionScopes(targets, bindings, db, record.id, options.pgPool);

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
      pendingRoleCleanups: removeRoleCleanups(
        previousScopes ? enqueueRoleCleanups(
          { ...current, apiKeys },
          record.id,
          previousScopes,
          new Set(Object.values(accessScopes ?? {}).map((scope) => scope.roleToken)),
        ) : current.pendingRoleCleanups,
        accessScopes,
      ),
    };
  });

  if (!updatedRecord) {
    throw new ApiKeyError(
      "API key not found or is not active",
      "KEY_NOT_FOUND",
    );
  }

  if (previousScopes) await retryPendingRoleCleanups(db, requirePool(options.pgPool), true);

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
    return revokeApiKey(apiKeyOrId, db, auditPath, options?.pgPool);
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
      ...(deletedRecord && {
        pendingRoleCleanups: enqueueRoleCleanups(
          { ...current, apiKeys }, deletedRecord.id, deletedRecord.accessScopes,
        ),
      }),
    };
  });

  const success = deletedRecord !== null;

  if (deletedRecord) {
    const rec = deletedRecord as ApiKeyRecord;
    await retryPendingRoleCleanups(db, requirePool(options?.pgPool), true);
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
  return db.listApiKeys();
}

/**
 * Retrieves a single API key record by its ID.
 */
export async function getApiKeyById(
  id: string,
  db: JsonDB = new JsonDB(),
): Promise<ApiKeyRecord | null> {
  return await db.findApiKeyById(id) ?? null;
}
