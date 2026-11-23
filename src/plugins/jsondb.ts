import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseAccess } from "../config/query-privileges.js";

let sqlite: Promise<typeof import("node:sqlite")> | undefined;
const schemaVersion = 1;
const writeQueues = new Map<string, Promise<void>>();

function loadSQLite() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    throw new Error(`Node.js 22.13+ on the 22.x line or 23.4+ is required. Running ${process.versions.node}.`);
  }
  return sqlite ??= import("node:sqlite").then((module) => {
    if (typeof module.DatabaseSync !== "function") throw new Error("SQLite DatabaseSync is unavailable");
    return module;
  }).catch((cause) => {
    throw new Error("Metadata storage requires an enabled node:sqlite module.", { cause });
  });
}

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  databases: string[];
  databaseOids?: Record<string, string>;
  databaseScopes?: Record<string, unknown>;
  accessScopes?: Record<string, DatabaseAccess>;
  environment: "LIVE" | "TEST";
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface PendingRoleCleanup {
  id: string;
  keyId: string;
  database: string;
  roleToken: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  cleanupAfter?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

export interface DataStore {
  admin?: { hash: string };
  apiKeys?: Record<string, ApiKeyRecord>;
  queryRoleSecret?: string;
  pendingRoleCleanups?: Record<string, PendingRoleCleanup>;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateApiKey(value: unknown, hash: string): value is ApiKeyRecord {
  return isObject(value) && value.keyHash === hash && typeof value.id === "string" &&
    typeof value.keyPrefix === "string" && Array.isArray(value.databases) &&
    (value.environment === "LIVE" || value.environment === "TEST") &&
    (value.status === "active" || value.status === "revoked") && typeof value.createdAt === "string";
}

function parseObject(text: unknown, description: string): Record<string, unknown> {
  if (typeof text !== "string") throw new Error(`Invalid ${description} in metadata database`);
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`Invalid ${description} in metadata database`);
  return parsed;
}

function cleanupFromRow(row: unknown): PendingRoleCleanup | undefined {
  if (!isObject(row) || typeof row.id !== "string" || typeof row.key_id !== "string" ||
      typeof row.database_name !== "string" || typeof row.role_token !== "string" ||
      typeof row.created_at !== "string" || typeof row.attempts !== "number") return undefined;
  return {
    id: row.id, keyId: row.key_id, database: row.database_name, roleToken: row.role_token,
    createdAt: row.created_at, attempts: row.attempts,
    ...(typeof row.last_attempt_at === "string" && { lastAttemptAt: row.last_attempt_at }),
    ...(typeof row.next_attempt_at === "string" && { nextAttemptAt: row.next_attempt_at }),
    ...(typeof row.last_error === "string" && { lastError: row.last_error }),
    ...(typeof row.cleanup_after === "string" && { cleanupAfter: row.cleanup_after }),
    ...(typeof row.lease_owner === "string" && { leaseOwner: row.lease_owner }),
    ...(typeof row.lease_expires_at === "string" && { leaseExpiresAt: row.lease_expires_at }),
  };
}

export class JsonDB {
  readonly filePath: string;
  readonly legacyPath: string;
  readonly backupPath: string;
  readonly dirPath: string;
  private database?: DatabaseSync;
  private opening?: Promise<DatabaseSync>;
  private operationErrors = 0;

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(this.filePath) ?? Promise.resolve();
    const result = previous.then(operation);
    void result.catch(() => { this.operationErrors++; });
    const settled = result.then(() => {}, () => {});
    writeQueues.set(this.filePath, settled);
    void settled.then(() => {
      if (writeQueues.get(this.filePath) === settled) writeQueues.delete(this.filePath);
    });
    return result;
  }

  constructor(customPath?: string) {
    const requested = resolve(customPath ?? "data/data.json");
    this.legacyPath = extname(requested) === ".json" ? requested : requested.replace(/\.sqlite$/, ".json");
    this.filePath = extname(requested) === ".json" ? requested.replace(/\.json$/, ".sqlite") : requested;
    this.backupPath = `${this.legacyPath}.backup`;
    this.dirPath = dirname(this.filePath);
  }

  private async open(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    this.opening = this.initialize().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async initialize(): Promise<DatabaseSync> {
    const { DatabaseSync } = await loadSQLite();
    await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.filePath);
    try {
      await chmod(this.filePath, 0o600);
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS api_keys (
          key_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
          environment TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
          last_used_at TEXT, record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS api_keys_status_idx ON api_keys(status);
        CREATE INDEX IF NOT EXISTS api_keys_last_used_idx ON api_keys(last_used_at);
        CREATE TABLE IF NOT EXISTS api_key_bindings (
          key_hash TEXT NOT NULL REFERENCES api_keys(key_hash) ON DELETE CASCADE,
          database_name TEXT NOT NULL, database_oid TEXT, access_scope_json TEXT,
          role_token TEXT, role_owner TEXT, PRIMARY KEY (key_hash, database_name)
        );
        CREATE INDEX IF NOT EXISTS api_key_bindings_role_idx ON api_key_bindings(database_name, role_token);
        CREATE TABLE IF NOT EXISTS pending_role_cleanups (
          id TEXT PRIMARY KEY, key_id TEXT NOT NULL, database_name TEXT NOT NULL,
          role_token TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL,
          last_attempt_at TEXT, next_attempt_at TEXT, last_error TEXT, cleanup_after TEXT,
          lease_owner TEXT, lease_expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS role_cleanup_due_idx
          ON pending_role_cleanups(next_attempt_at, cleanup_after, created_at);
      `);
      const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      const current = isObject(version) && typeof version.version === "number" ? version.version : 0;
      if (current > schemaVersion) throw new Error(`Metadata schema ${current} is newer than supported schema ${schemaVersion}`);
      if (current === 0) await this.migrateOrInitialize(db);
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw new Error(`Failed to initialize metadata database at ${this.filePath}`, { cause: error });
    }
  }

  private async migrateOrInitialize(db: DatabaseSync, initialData: DataStore = {}) {
    let source = initialData;
    const legacy = await readFile(this.legacyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (legacy !== undefined) {
      let parsed: unknown;
      try {
        parsed = legacy.trim() ? JSON.parse(legacy) : {};
      } catch (error) {
        throw new Error(`Failed to parse legacy JSON metadata at ${this.legacyPath}`, { cause: error });
      }
      if (!isObject(parsed)) throw new Error(`Legacy JSON metadata at ${this.legacyPath} must contain an object`);
      source = parsed;
      const backupExists = await stat(this.backupPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!backupExists) {
        const temporary = `${this.backupPath}.${process.pid}.tmp`;
        await copyFile(this.legacyPath, temporary);
        try {
          await rename(temporary, this.backupPath);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          const appeared = await stat(this.backupPath).then(() => true, () => false);
          if (!appeared) throw error;
        }
      }
      await chmod(this.backupPath, 0o600);
    }
    this.validateStore(source);
    db.exec("BEGIN IMMEDIATE");
    try {
      const migrated = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      if (isObject(migrated) && typeof migrated.version === "number" && migrated.version >= schemaVersion) {
        db.exec("COMMIT");
        return;
      }
      this.replaceInTransaction(db, source);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(schemaVersion, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private validateStore(data: DataStore) {
    if (data.admin !== undefined && (!isObject(data.admin) || typeof data.admin.hash !== "string")) {
      throw new Error("Invalid admin metadata");
    }
    for (const [hash, record] of Object.entries(data.apiKeys ?? {})) {
      if (!validateApiKey(record, hash)) throw new Error(`Invalid API key metadata for hash ${hash.slice(0, 8)}`);
    }
    for (const [id, cleanup] of Object.entries(data.pendingRoleCleanups ?? {})) {
      if (!isObject(cleanup) || cleanup.id !== id || typeof cleanup.roleToken !== "string" ||
          typeof cleanup.database !== "string" || typeof cleanup.keyId !== "string") {
        throw new Error(`Invalid pending role cleanup ${id}`);
      }
    }
  }

  private readFrom(db: DatabaseSync): DataStore {
    const result: DataStore = {};
    for (const row of db.prepare("SELECT key, value FROM metadata").all()) {
      if (!isObject(row) || typeof row.key !== "string" || typeof row.value !== "string") continue;
      result[row.key] = JSON.parse(row.value);
    }
    const apiKeys: Record<string, ApiKeyRecord> = {};
    for (const row of db.prepare("SELECT key_hash, record_json FROM api_keys").all()) {
      if (!isObject(row) || typeof row.key_hash !== "string") continue;
      const record = parseObject(row.record_json, "API key record");
      if (!validateApiKey(record, row.key_hash)) throw new Error("Invalid API key record in metadata database");
      apiKeys[row.key_hash] = record;
    }
    if (Object.keys(apiKeys).length) result.apiKeys = apiKeys;
    const cleanups: Record<string, PendingRoleCleanup> = {};
    for (const row of db.prepare("SELECT * FROM pending_role_cleanups").all()) {
      const cleanup = cleanupFromRow(row);
      if (cleanup) cleanups[cleanup.id] = cleanup;
    }
    if (Object.keys(cleanups).length) result.pendingRoleCleanups = cleanups;
    return result;
  }

  private replaceInTransaction(db: DatabaseSync, data: DataStore) {
    this.validateStore(data);
    db.exec("DELETE FROM api_key_bindings; DELETE FROM api_keys; DELETE FROM pending_role_cleanups; DELETE FROM metadata;");
    const insertMetadata = db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(data)) {
      if (key === "apiKeys" || key === "pendingRoleCleanups" || value === undefined) continue;
      insertMetadata.run(key, JSON.stringify(value));
    }
    const insertKey = db.prepare(`INSERT INTO api_keys
      (key_hash, id, status, environment, created_at, revoked_at, last_used_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertBinding = db.prepare(`INSERT INTO api_key_bindings
      (key_hash, database_name, database_oid, access_scope_json, role_token, role_owner)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [hash, record] of Object.entries(data.apiKeys ?? {})) {
      insertKey.run(hash, record.id, record.status, record.environment, record.createdAt,
        record.revokedAt ?? null, record.lastUsedAt ?? null, JSON.stringify(record));
      for (const database of record.databases) {
        const scope = record.accessScopes?.[database];
        insertBinding.run(hash, database, record.databaseOids?.[database] ?? null,
          scope ? JSON.stringify(scope) : null, scope?.roleToken ?? null, scope?.roleOwner ?? null);
      }
    }
    const insertCleanup = db.prepare(`INSERT INTO pending_role_cleanups
      (id, key_id, database_name, role_token, created_at, attempts, last_attempt_at,
       next_attempt_at, last_error, cleanup_after, lease_owner, lease_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const cleanup of Object.values(data.pendingRoleCleanups ?? {})) {
      insertCleanup.run(cleanup.id, cleanup.keyId, cleanup.database, cleanup.roleToken,
        cleanup.createdAt, cleanup.attempts, cleanup.lastAttemptAt ?? null,
        cleanup.nextAttemptAt ?? null, cleanup.lastError ?? null, cleanup.cleanupAfter ?? null,
        cleanup.leaseOwner ?? null, cleanup.leaseExpiresAt ?? null);
    }
  }

  async ensureExists(initialData: DataStore = {}): Promise<void> {
    const existed = await stat(this.filePath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const db = await this.open();
    if (!existed && Object.keys(initialData).length && Object.keys(this.readFrom(db)).length === 0) await this.write(initialData);
  }

  async read<T = DataStore>(): Promise<T> {
    return this.readFrom(await this.open()) as T;
  }

  async findApiKey(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const row = (await this.open()).prepare("SELECT record_json FROM api_keys WHERE key_hash = ?").get(keyHash);
    if (!isObject(row)) return undefined;
    const record = parseObject(row.record_json, "API key record");
    if (!validateApiKey(record, keyHash)) throw new Error("Invalid API key record in metadata database");
    return record;
  }

  async findApiKeyById(id: string): Promise<ApiKeyRecord | undefined> {
    const row = (await this.open()).prepare("SELECT key_hash, record_json FROM api_keys WHERE id = ?").get(id);
    if (!isObject(row) || typeof row.key_hash !== "string") return undefined;
    const record = parseObject(row.record_json, "API key record");
    if (!validateApiKey(record, row.key_hash)) throw new Error("Invalid API key record in metadata database");
    return record;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const records: ApiKeyRecord[] = [];
    for (const row of (await this.open()).prepare("SELECT key_hash, record_json FROM api_keys ORDER BY created_at").all()) {
      if (!isObject(row) || typeof row.key_hash !== "string") continue;
      const record = parseObject(row.record_json, "API key record");
      if (!validateApiKey(record, row.key_hash)) throw new Error("Invalid API key record in metadata database");
      records.push(record);
    }
    return records;
  }

  async listRoleCleanups(): Promise<PendingRoleCleanup[]> {
    return (await this.open()).prepare("SELECT * FROM pending_role_cleanups ORDER BY created_at, id")
      .all().flatMap((row) => {
        const cleanup = cleanupFromRow(row);
        return cleanup ? [cleanup] : [];
      });
  }

  async metrics() {
    const now = new Date().toISOString();
    const row = (await this.open()).prepare(`SELECT
      COUNT(*) AS pending,
      SUM(CASE WHEN cleanup_after > ? THEN 1 ELSE 0 END) AS provisioning,
      SUM(attempts) AS failed
      FROM pending_role_cleanups`).get(now);
    return {
      pendingRoleProvisioning: isObject(row) && typeof row.provisioning === "number" ? row.provisioning : 0,
      pendingRoleCleanup: isObject(row) && typeof row.pending === "number" ? row.pending : 0,
      failedCleanupAttempts: isObject(row) && typeof row.failed === "number" ? row.failed : 0,
      operationErrors: this.operationErrors,
    };
  }

  async isRoleActive(database: string, roleToken: string): Promise<boolean> {
    const row = (await this.open()).prepare(`
      SELECT 1 AS active FROM api_key_bindings b
      JOIN api_keys k ON k.key_hash = b.key_hash
      WHERE b.database_name = ? AND b.role_token = ? AND k.status = 'active' LIMIT 1
    `).get(database, roleToken);
    return isObject(row) && row.active === 1;
  }

  async claimRoleCleanups(
    leaseOwner: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
    force = false,
  ): Promise<PendingRoleCleanup[]> {
    return this.withWrite(async () => {
      const db = await this.open();
      db.exec("BEGIN IMMEDIATE");
      try {
        const due = db.prepare(`SELECT id FROM pending_role_cleanups
          WHERE (cleanup_after IS NULL OR cleanup_after <= ?)
            AND (? = 1 OR next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY COALESCE(next_attempt_at, cleanup_after, created_at), id LIMIT ?`)
          .all(now, force ? 1 : 0, now, now, limit)
          .flatMap((row) => isObject(row) && typeof row.id === "string" ? [row.id] : []);
        const claim = db.prepare(`UPDATE pending_role_cleanups
          SET lease_owner = ?, lease_expires_at = ? WHERE id = ?`);
        for (const id of due) claim.run(leaseOwner, leaseExpiresAt, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return db.prepare("SELECT * FROM pending_role_cleanups WHERE lease_owner = ?")
        .all(leaseOwner).flatMap((row) => {
          const cleanup = cleanupFromRow(row);
          return cleanup ? [cleanup] : [];
        });
    });
  }

  async completeRoleCleanup(id: string, leaseOwner: string): Promise<void> {
    await this.withWrite(async () => {
      (await this.open()).prepare("DELETE FROM pending_role_cleanups WHERE id = ? AND lease_owner = ?")
        .run(id, leaseOwner);
    });
  }

  async failRoleCleanup(
    id: string,
    leaseOwner: string,
    attemptedAt: string,
    nextAttemptAt: string,
    error: string,
  ): Promise<void> {
    await this.withWrite(async () => {
      (await this.open()).prepare(`UPDATE pending_role_cleanups SET
        attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?, last_error = ?,
        lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_owner = ?`)
        .run(attemptedAt, nextAttemptAt, error, id, leaseOwner);
    });
  }

  async write<T = DataStore>(data: T): Promise<void> {
    if (!isObject(data)) throw new Error("Metadata must be an object");
    await this.withWrite(async () => {
      const db = await this.open();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.replaceInTransaction(db, data);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = (await this.open()).prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    return isObject(row) && typeof row.value === "string" ? JSON.parse(row.value) : undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.withWrite(async () => {
      const db = await this.open();
      db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
    });
  }

  async update<T = DataStore>(updater: (current: T) => T | Promise<T>): Promise<T> {
    return this.withWrite(async () => {
      const db = await this.open();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.readFrom(db) as T;
        const updated = await updater(current);
        if (!isObject(updated)) throw new Error("Metadata updater must return an object");
        this.replaceInTransaction(db, updated);
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close() {
    await writeQueues.get(this.filePath);
    const db = this.database;
    this.database = undefined;
    db?.close();
  }
}

declare module "fastify" { interface FastifyInstance { jsondb: JsonDB; } }

export interface JsonDBPluginOptions { path?: string; initialData?: DataStore; }

const jsondbPlugin: FastifyPluginAsync<JsonDBPluginOptions> = async (app, opts) => {
  await loadSQLite();
  const db = new JsonDB(opts.path);
  await db.ensureExists(opts.initialData);
  app.decorate("jsondb", db);
  app.addHook("onClose", () => db.close());
  app.log.info({ path: db.filePath }, "SQLite metadata initialized");
};

export default fp(jsondbPlugin, { name: "jsondb" });
