import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

interface Usage { totalQueries: number; failedQueries: number; lastUsedAt: string }
interface FailedQuery {
  keyId: string; database: string; query: string; truncated: boolean; status: number;
  code?: string; pgCode?: string; occurredAt: string;
}
interface Batch { usage: Array<[string, Usage]>; failures: FailedQuery[] }
interface StoredBatch { id: string; batch: Batch }
type Request =
  | { type: "flush"; id: string; batch: Batch }
  | { type: "report"; id: string; limit: number }
  | { type: "clear"; id: string }
  | { type: "close"; id: string; batch: Batch; deadlineMs: number };

if (!parentPort) throw new Error("Analytics worker requires a parent port");
const port = parentPort;
const directory = workerData.directory as string;
const databaseFile = join(directory, "analytics.sqlite");
const spoolFile = join(directory, "analytics-pending.json");
const retentionDays = workerData.retentionDays as number;
const maxStorageBytes = workerData.maxStorageBytes as number;
let database: DatabaseSync | undefined;
let pending: StoredBatch[] = [];
let operations = Promise.resolve();
const maxBufferedFailures = 256;
const pendingAcks = new Set<string>();
let lastMaintenance = 0;

function hasPending() {
  return pending.length > 0;
}

function appendBatch(id: string, batch: Batch) {
  if (pending.some((item) => item.id === id)) return;
  const bufferedFailures = pending.reduce((count, item) => count + item.batch.failures.length, 0);
  pending.push({ id, batch: {
    usage: batch.usage,
    failures: batch.failures.slice(0, Math.max(0, maxBufferedFailures - bufferedFailures)),
  } });
}

function openDatabase() {
  if (database) return database;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  closeSync(openSync(databaseFile, "a", 0o600));
  const connection = new DatabaseSync(databaseFile);
  connection.exec(`
    PRAGMA busy_timeout = 250;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS key_usage (
      key_id TEXT PRIMARY KEY, total_queries INTEGER NOT NULL,
      failed_queries INTEGER NOT NULL, last_used_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS failed_queries (
      id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, database_name TEXT NOT NULL,
      sql TEXT NOT NULL, truncated INTEGER NOT NULL, status INTEGER NOT NULL,
      code TEXT, pg_code TEXT, occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS failed_queries_recent_idx
      ON failed_queries (occurred_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS analytics_batches (
      id TEXT PRIMARY KEY, processed_at TEXT NOT NULL
    );
  `);
  const pageSize = Number((connection.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  connection.exec(`PRAGMA journal_size_limit = ${Math.min(4_194_304, Math.floor(maxStorageBytes / 8))}`);
  connection.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maxStorageBytes * 0.75 / pageSize))}`);
  database = connection;
  return connection;
}

function physicalStorageBytes() {
  return [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`, spoolFile]
    .reduce((total, file) => total + (() => { try { return statSync(file).size; } catch { return 0; } })(), 0);
}

function maintainStorage(db: DatabaseSync, force = false) {
  if (!force && Date.now() - lastMaintenance < 60_000) return;
  lastMaintenance = Date.now();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare(`DELETE FROM failed_queries WHERE id IN (
    SELECT id FROM failed_queries WHERE occurred_at < ? ORDER BY id LIMIT 1000
  )`).run(cutoff);
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  for (let batch = 0; batch < 32; batch++) {
    const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const free = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    if ((pages - free) * pageSize <= maxStorageBytes * 0.7 && physicalStorageBytes() <= maxStorageBytes * 0.85) break;
    const removed = db.prepare(`DELETE FROM failed_queries WHERE id IN (
      SELECT id FROM failed_queries ORDER BY occurred_at, id LIMIT 1000
    )`).run().changes;
    if (!removed) break;
  }
  db.prepare("DELETE FROM analytics_batches WHERE processed_at < ?")
    .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
}

function flushPending() {
  if (!hasPending()) return;
  const db = openDatabase();
  maintainStorage(db, physicalStorageBytes() >= maxStorageBytes * 0.75);
  const increment = db.prepare(`
    INSERT INTO key_usage VALUES (?, ?, ?, ?)
    ON CONFLICT (key_id) DO UPDATE SET
      total_queries = key_usage.total_queries + excluded.total_queries,
      failed_queries = key_usage.failed_queries + excluded.failed_queries,
      last_used_at = MAX(key_usage.last_used_at, excluded.last_used_at)
  `);
  const insert = db.prepare(`
    INSERT INTO failed_queries
      (key_id, database_name, sql, truncated, status, code, pg_code, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of pending) {
      const fresh = db.prepare("INSERT OR IGNORE INTO analytics_batches VALUES (?, ?)")
        .run(item.id, new Date().toISOString()).changes > 0;
      if (!fresh) continue;
      for (const [keyId, counts] of item.batch.usage) {
        increment.run(keyId, counts.totalQueries, counts.failedQueries, counts.lastUsedAt);
      }
      for (const failure of item.batch.failures) {
        insert.run(failure.keyId, failure.database, failure.query, Number(failure.truncated),
          failure.status, failure.code ?? null, failure.pgCode ?? null, failure.occurredAt);
      }
    }
    db.exec("COMMIT");
    pending = [];
    for (const id of pendingAcks) port.postMessage({ type: "ack", id });
    pendingAcks.clear();
    try { maintainStorage(db); } catch (error) {
      port.postMessage({ type: "log", level: "warn", message: "Could not prune query analytics", error: String(error) });
    }
    try { unlinkSync(spoolFile); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    const code = error && typeof error === "object" && "errcode" in error ? Number(error.errcode) & 255 : undefined;
    if (code === 13) {
      try { maintainStorage(db, true); } catch {}
      port.postMessage({ type: "log", level: "warn", message: "Analytics storage quota was reached; pruning before retry", error: String(error) });
    }
    throw error;
  }
}

function report(limit: number) {
  flushPending();
  const db = openDatabase();
  db.exec("BEGIN");
  try {
    const keys = db.prepare(`
      SELECT key_id AS keyId, total_queries AS totalQueries,
             failed_queries AS failedQueries, last_used_at AS lastUsedAt
      FROM key_usage ORDER BY total_queries DESC, key_id
    `).all() as unknown as Array<Usage & { keyId: string }>;
    const totals = keys.reduce((sum, key) => ({
      totalQueries: sum.totalQueries + key.totalQueries,
      failedQueries: sum.failedQueries + key.failedQueries,
    }), { totalQueries: 0, failedQueries: 0 });
    const recentFailures = db.prepare(`
      SELECT key_id AS keyId, database_name AS database, sql AS query, truncated,
             status, code, pg_code AS pgCode, occurred_at AS occurredAt
      FROM failed_queries ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, truncated: row.truncated === 1 }));
    db.exec("COMMIT");
    return { ...totals, keys, recentFailures };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function persistPending() {
  if (!hasPending()) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${spoolFile}.${process.pid}.tmp`;
  let serialized = JSON.stringify(pending);
  while (Buffer.byteLength(serialized) + physicalStorageBytes() > maxStorageBytes && pending.some((item) => item.batch.failures.length)) {
    const item = pending.find((candidate) => candidate.batch.failures.length);
    item?.batch.failures.pop();
    serialized = JSON.stringify(pending);
  }
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, spoolFile);
}

try {
  const stored = JSON.parse(readFileSync(spoolFile, "utf8")) as StoredBatch[] | Batch;
  pending = Array.isArray(stored) ? stored : [{ id: `legacy-${Date.now()}`, batch: stored }];
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    port.postMessage({ type: "log", level: "error", message: "Could not load analytics spool", error: String(error) });
  }
}

const retryTimer = setInterval(() => {
  operations = operations.then(() => {
    try {
      if (hasPending()) flushPending();
      else maintainStorage(openDatabase());
    } catch {}
  });
}, 1_000);
retryTimer.unref();

port.on("message", (request: Request) => {
  operations = operations.then(async () => {
    if (request.type === "flush") {
      appendBatch(request.id, request.batch);
      pendingAcks.add(request.id);
      try { flushPending(); } catch (error) {
        port.postMessage({ type: "log", level: "warn", message: "Could not write query analytics", error: String(error) });
      }
      return;
    }
    if (request.type === "report") {
      try {
        port.postMessage({ type: "response", id: request.id, result: report(request.limit) });
      } catch (error) {
        port.postMessage({ type: "response", id: request.id, error: String(error) });
      }
      return;
    }
    if (request.type === "clear") {
      pending = [];
      pendingAcks.clear();
      const db = openDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM failed_queries;");
        db.exec("DELETE FROM key_usage;");
        db.exec("DELETE FROM analytics_batches;");
        db.exec("COMMIT");
        try { unlinkSync(spoolFile); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
        port.postMessage({ type: "response", id: request.id, result: { success: true } });
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        port.postMessage({ type: "response", id: request.id, error: String(error) });
      }
      return;
    }
    appendBatch(request.id, request.batch);
    const deadline = performance.now() + request.deadlineMs;
    while (hasPending() && performance.now() < deadline) {
      try { flushPending(); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    if (hasPending()) persistPending();
    clearInterval(retryTimer);
    database?.close();
    port.postMessage({ type: "response", id: request.id, result: { spooled: hasPending() } });
  }).catch((error) => {
    port.postMessage({ type: "log", level: "error", message: "Analytics worker operation failed", error: String(error) });
    port.postMessage({ type: "response", id: request.id, error: String(error) });
  });
});
