import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { executionErrorCodes, type ExecutionOutcome } from "../routes/execution-store.js";

const maxBufferedFailures = 256;
const maxSqlLength = 8_192;
interface Usage { totalQueries: number; failedQueries: number; lastUsedAt: string }
interface FailedQuery { keyId: string; database: string; query: string; truncated: boolean; status: number; code?: string; pgCode?: string; occurredAt: string }
interface Batch { usage: Array<[string, Usage]>; failures: FailedQuery[] }
interface AnalyticsOptions { retentionDays: number; maxStorageBytes: number; storeFullSql: boolean }
interface PendingRequest { resolve: (value: any) => void; reject: (error: Error) => void }

function redactSqlLiterals(sql: string) {
  let output = "";
  let index = 0;
  const identifier = (value: string | undefined) => value !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(value);
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      const end = sql.slice(index + 2).search(/[\r\n]/);
      index = end < 0 ? sql.length : index + 2 + end;
      output += " ";
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      output += " ";
      continue;
    }
    if (sql[index] === "'") {
      index++;
      while (index < sql.length) {
        if (sql[index] === "\\") { index += 2; continue; }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index++;
          break;
        }
        index++;
      }
      output += "?";
      continue;
    }
    if (sql[index] === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        index = end < 0 ? sql.length : end + tag.length;
        output += "?";
        continue;
      }
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(index))?.[0];
    if (number && !identifier(sql[index - 1]) && !identifier(sql[index + number.length])) {
      output += "?";
      index += number.length;
      continue;
    }
    if (sql[index] === '"') {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === '"') {
          index++;
          if (sql[index] === '"') { index++; continue; }
          break;
        }
        index++;
      }
      output += sql.slice(start, index);
      continue;
    }
    output += sql[index++];
  }
  return output.trim();
}

export function createQueryAnalytics(directory: string, log: FastifyBaseLogger, options: AnalyticsOptions) {
  const usage = new Map<string, Usage>();
  const failures: FailedQuery[] = [];
  const requests = new Map<string, PendingRequest>();
  let worker: Worker | undefined;
  let workerOnline = false;
  let inFlight: { id: string; batch: Batch; promise: Promise<void> } | undefined;
  let resolveInFlight: (() => void) | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let restartDelay = 100;
  let closed = false;
  let bufferFull = false;

  function spawnWorker() {
    if (closed || worker) return;
    const instance = new Worker(new URL("./query-analytics-worker.js", import.meta.url), {
      workerData: { directory: resolve(directory), ...options },
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    worker = instance;
    instance.on("online", () => {
      workerOnline = true;
      restartDelay = 100;
      if (inFlight) instance.postMessage({ type: "flush", id: inFlight.id, batch: inFlight.batch });
    });
    instance.on("message", (message: any) => {
      if (message.type === "log") {
        const details = { analyticsWorkerError: message.error };
        if (message.level === "error") log.error(details, message.message);
        else log.warn(details, message.message);
        return;
      }
      if (message.type === "ack" && inFlight?.id === message.id) {
        inFlight = undefined;
        resolveInFlight?.();
        resolveInFlight = undefined;
        flush();
        return;
      }
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    instance.on("error", (error) => log.error({ err: error }, "Query analytics worker failed"));
    instance.on("exit", (code) => {
      if (worker === instance) {
        worker = undefined;
        workerOnline = false;
      }
      const error = new Error(`Query analytics worker exited with code ${code}`);
      for (const pending of requests.values()) pending.reject(error);
      requests.clear();
      if (!closed) {
        log.warn({ code }, "Restarting query analytics worker");
        restartTimer = setTimeout(spawnWorker, restartDelay);
        restartTimer.unref();
        restartDelay = Math.min(restartDelay * 2, 10_000);
      }
    });
  }
  spawnWorker();

  function takeBatch(): Batch {
    const batch = { usage: [...usage.entries()], failures: failures.splice(0) };
    usage.clear();
    bufferFull = false;
    return batch;
  }

  function flush() {
    if (closed || inFlight || (!usage.size && !failures.length)) return;
    const id = randomUUID();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    resolveInFlight = resolve;
    inFlight = { id, batch: takeBatch(), promise };
    if (workerOnline) worker?.postMessage({ type: "flush", id, batch: inFlight.batch });
  }
  const timer = setInterval(flush, 1_000).unref();

  async function waitForFlush(timeoutMs: number) {
    flush();
    const pending = inFlight?.promise;
    if (!pending) return;
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Analytics flush timed out")), timeoutMs).unref()),
    ]);
  }

  function send(type: "report" | "close", extra: Record<string, unknown>, batch?: Batch) {
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      if (!worker) return reject(new Error("Query analytics worker is unavailable"));
      if (requests.size >= 8) return reject(new Error("Query analytics worker request queue is full"));
      requests.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...(batch && { batch }), ...extra });
    });
  }

  function record(keyId: string, database: string, sql: string, outcome?: ExecutionOutcome) {
    if (closed) return;
    const failed = outcome !== undefined && outcome.status >= 400;
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
    const storedSql = options.storeFullSql ? sql : redactSqlLiterals(sql);
    failures.push({ keyId, database, query: storedSql.slice(0, maxSqlLength), truncated: storedSql.length > maxSqlLength,
      status: outcome.status, ...executionErrorCodes(outcome), occurredAt });
  }

  async function report(limit: number) {
    if (closed) throw new Error("Query analytics is closed");
    await waitForFlush(1_000);
    return send("report", { limit });
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(restartTimer);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        send("close", { deadlineMs: 5_000 }, takeBatch()),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Analytics worker shutdown timed out")), 6_000);
          timeout.unref();
        }),
      ]);
      if (result.spooled) log.warn("Buffered query analytics were spooled during shutdown");
    } finally {
      clearTimeout(timeout);
      await worker?.terminate();
    }
  }

  return { record, report, close };
}

export type QueryAnalytics = ReturnType<typeof createQueryAnalytics>;
