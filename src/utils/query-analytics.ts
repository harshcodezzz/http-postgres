import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import { executionErrorCodes, type ExecutionOutcome } from "../routes/execution-store.js";

const maxBufferedFailures = 256;
const maxSqlLength = 8_192;

interface Usage {
  totalQueries: number;
  failedQueries: number;
  lastUsedAt: string;
}

interface FailedQuery {
  keyId: string;
  database: string;
  query: string;
  truncated: boolean;
  status: number;
  code?: string;
  pgCode?: string;
  occurredAt: string;
}

function inTransaction<T>(db: DatabaseSync, begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
  db.exec(begin);
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite can already have rolled back a failed commit.
    }
    throw error;
  }
}

export function createQueryAnalytics(directory: string, log: FastifyBaseLogger) {
  const path = resolve(directory);
  const usage = new Map<string, Usage>();
  const failures: FailedQuery[] = [];
  let database: DatabaseSync | undefined;
  let storageFailed = false;
  let bufferFull = false;

  function openDatabase() {
    if (database) return database;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const file = join(path, "analytics.sqlite");
    closeSync(openSync(file, "a", 0o600));
    const connection = new DatabaseSync(file);
    try {
      connection.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS key_usage (
          key_id TEXT PRIMARY KEY,
          total_queries INTEGER NOT NULL,
          failed_queries INTEGER NOT NULL,
          last_used_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS failed_queries (
          id INTEGER PRIMARY KEY,
          key_id TEXT NOT NULL,
          database_name TEXT NOT NULL,
          sql TEXT NOT NULL,
          truncated INTEGER NOT NULL,
          status INTEGER NOT NULL,
          code TEXT,
          pg_code TEXT,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS failed_queries_recent_idx ON failed_queries (occurred_at DESC, id DESC);
      `);
      database = connection;
      return database;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  function flush() {
    if (!usage.size) return;
    const db = openDatabase();
    const increment = db.prepare(`
      INSERT INTO key_usage VALUES (?, ?, ?, ?)
      ON CONFLICT (key_id) DO UPDATE SET
        total_queries = key_usage.total_queries + excluded.total_queries,
        failed_queries = key_usage.failed_queries + excluded.failed_queries,
        last_used_at = MAX(key_usage.last_used_at, excluded.last_used_at)
    `);
    const insert = db.prepare(`
      INSERT INTO failed_queries (key_id, database_name, sql, truncated, status, code, pg_code, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    inTransaction(db, "BEGIN IMMEDIATE", () => {
      for (const [keyId, counts] of usage) {
        increment.run(keyId, counts.totalQueries, counts.failedQueries, counts.lastUsedAt);
      }
      for (const failure of failures) {
        insert.run(
          failure.keyId, failure.database, failure.query, Number(failure.truncated),
          failure.status, failure.code ?? null, failure.pgCode ?? null, failure.occurredAt,
        );
      }
    });
    usage.clear();
    failures.length = 0;
    storageFailed = false;
    bufferFull = false;
  }

  function flushSafely() {
    try {
      flush();
      return true;
    } catch (error) {
      if (!storageFailed) log.warn({ err: error }, "Could not write query analytics");
      storageFailed = true;
      return false;
    }
  }

  const timer = setInterval(flushSafely, 1_000).unref();

  function record(keyId: string, database: string, sql: string, outcome?: ExecutionOutcome) {
    const failed = outcome !== undefined && outcome.status >= 400;
    if (failed && failures.length >= maxBufferedFailures && !storageFailed) flushSafely();
    const occurredAt = new Date().toISOString();
    const counts = usage.get(keyId) ?? { totalQueries: 0, failedQueries: 0, lastUsedAt: occurredAt };
    counts.totalQueries++;
    if (failed) counts.failedQueries++;
    if (occurredAt > counts.lastUsedAt) counts.lastUsedAt = occurredAt;
    usage.set(keyId, counts);

    if (!failed) return;
    if (failures.length >= maxBufferedFailures) {
      if (!bufferFull) log.warn("Query analytics failure buffer is full");
      bufferFull = true;
      return;
    }
    failures.push({
      keyId, database, query: sql.slice(0, maxSqlLength), truncated: sql.length > maxSqlLength,
      status: outcome.status, ...executionErrorCodes(outcome), occurredAt,
    });
  }

  function report(limit: number) {
    flush();
    const db = openDatabase();
    return inTransaction(db, "BEGIN", () => {
      const keys = db.prepare(`
        SELECT key_id AS keyId, total_queries AS totalQueries, failed_queries AS failedQueries,
               last_used_at AS lastUsedAt
        FROM key_usage ORDER BY total_queries DESC, key_id
      `).all() as unknown as Array<Usage & { keyId: string }>;
      const totals = keys.reduce((sum, key) => ({
        totalQueries: sum.totalQueries + key.totalQueries,
        failedQueries: sum.failedQueries + key.failedQueries,
      }), { totalQueries: 0, failedQueries: 0 });
      const recentFailures = db.prepare(`
        SELECT key_id AS keyId, database_name AS database, sql AS query, truncated,
               status, code, pg_code AS pgCode, occurred_at AS occurredAt
        FROM failed_queries
        ORDER BY occurred_at DESC, id DESC LIMIT ?
      `).all(limit).map((row) => ({ ...row, truncated: row.truncated === 1 }));
      return { ...totals, keys, recentFailures };
    });
  }

  async function close() {
    clearInterval(timer);
    try {
      while (usage.size) {
        try {
          flush();
        } catch (error) {
          const code = error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
          if (typeof code !== "number" || ((code & 255) !== 5 && (code & 255) !== 6)) throw error;
          if (!storageFailed) log.warn({ err: error }, "Waiting for the analytics writer before shutdown");
          storageFailed = true;
          await delay(50);
        }
      }
    } finally {
      database?.close();
    }
  }

  return { record, report, close };
}

export type QueryAnalytics = ReturnType<typeof createQueryAnalytics>;
