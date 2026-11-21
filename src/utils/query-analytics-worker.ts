import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

interface Usage { totalQueries: number; failedQueries: number; lastUsedAt: string }
interface FailedQuery {
  keyId: string; database: string; query: string; truncated: boolean; status: number;
  code?: string; pgCode?: string; occurredAt: string;
}
interface Batch { usage: Array<[string, Usage]>; failures: FailedQuery[] }
type Request =
  | { type: "flush"; id: string; batch: Batch }
  | { type: "report"; id: string; limit: number }
  | { type: "close"; id: string; batch: Batch; deadlineMs: number };

if (!parentPort) throw new Error("Analytics worker requires a parent port");
const port = parentPort;
const directory = workerData.directory as string;
const databaseFile = join(directory, "analytics.sqlite");
const spoolFile = join(directory, "analytics-pending.json");
const retentionDays = workerData.retentionDays as number;
const maxStorageBytes = workerData.maxStorageBytes as number;
let database: DatabaseSync | undefined;
let pending: Batch = { usage: [], failures: [] };
let operations = Promise.resolve();
const maxBufferedFailures = 256;
const pendingAcks = new Set<string>();
let lastMaintenance = 0;

function hasPending() {
  return pending.usage.length > 0 || pending.failures.length > 0;
}

function appendBatch(batch: Batch) {
  const usage = new Map(pending.usage);
  for (const [keyId, incoming] of batch.usage) {
    const current = usage.get(keyId);
    usage.set(keyId, current ? {
      totalQueries: current.totalQueries + incoming.totalQueries,
      failedQueries: current.failedQueries + incoming.failedQueries,
      lastUsedAt: current.lastUsedAt > incoming.lastUsedAt ? current.lastUsedAt : incoming.lastUsedAt,
    } : incoming);
  }
  pending.usage = [...usage.entries()];
  const availableFailures = maxBufferedFailures - pending.failures.length;
  if (availableFailures > 0) pending.failures.push(...batch.failures.slice(0, availableFailures));
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
  `);
  const pageSize = Number((connection.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  connection.exec(`PRAGMA journal_size_limit = ${Math.min(4_194_304, Math.floor(maxStorageBytes / 8))}`);
  connection.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maxStorageBytes / pageSize))}`);
  database = connection;
  return connection;
}

function maintainStorage(db: DatabaseSync) {
  if (Date.now() - lastMaintenance < 60_000) return;
  lastMaintenance = Date.now();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare(`DELETE FROM failed_queries WHERE id IN (
    SELECT id FROM failed_queries WHERE occurred_at < ? ORDER BY id LIMIT 1000
  )`).run(cutoff);
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  for (let batch = 0; batch < 32; batch++) {
    const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const free = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    if ((pages - free) * pageSize <= maxStorageBytes * 0.9) break;
    const removed = db.prepare(`DELETE FROM failed_queries WHERE id IN (
      SELECT id FROM failed_queries ORDER BY occurred_at, id LIMIT 1000
    )`).run().changes;
    if (!removed) break;
  }
}

function flushPending() {
  if (!hasPending()) return;
  const db = openDatabase();
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
    for (const [keyId, counts] of pending.usage) {
      increment.run(keyId, counts.totalQueries, counts.failedQueries, counts.lastUsedAt);
    }
    for (const failure of pending.failures) {
      insert.run(
        failure.keyId, failure.database, failure.query, Number(failure.truncated),
        failure.status, failure.code ?? null, failure.pgCode ?? null, failure.occurredAt,
      );
    }
    db.exec("COMMIT");
    pending = { usage: [], failures: [] };
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
  writeFileSync(temporary, JSON.stringify(pending), { mode: 0o600 });
  renameSync(temporary, spoolFile);
}

try {
  pending = JSON.parse(readFileSync(spoolFile, "utf8")) as Batch;
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
      appendBatch(request.batch);
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
    appendBatch(request.batch);
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
  });
});
