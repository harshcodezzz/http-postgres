import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import { executionErrorCodes, type ExecutionOutcome } from "../routes/execution-store.js";

const maxBufferedFailures = 256;
const maxSqlLength = 8_192;

interface Usage { totalQueries: number; failedQueries: number; lastUsedAt: string }
interface FailedQuery {
  keyId: string; database: string; query: string; truncated: boolean; status: number;
  code?: string; pgCode?: string; occurredAt: string;
}
interface Batch { usage: Array<[string, Usage]>; failures: FailedQuery[] }
interface PendingRequest { resolve: (value: any) => void; reject: (error: Error) => void }

export function createQueryAnalytics(directory: string, log: FastifyBaseLogger) {
  const usage = new Map<string, Usage>();
  const failures: FailedQuery[] = [];
  const worker = new Worker(new URL("./query-analytics-worker.js", import.meta.url), {
    workerData: { directory: resolve(directory) },
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
  });
  const requests = new Map<number, PendingRequest>();
  let requestId = 0;
  let closed = false;
  let workerExited = false;
  let bufferFull = false;

  worker.on("message", (message: any) => {
    if (message.type === "log") {
      const details = { analyticsWorkerError: message.error };
      if (message.level === "error") log.error(details, message.message);
      else log.warn(details, message.message);
      return;
    }
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  worker.on("error", (error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    log.error({ err: failure }, "Query analytics worker failed");
    for (const pending of requests.values()) pending.reject(failure);
    requests.clear();
  });
  worker.on("exit", (code) => {
    workerExited = true;
    if (closed && code === 0) return;
    const error = new Error(`Query analytics worker exited with code ${code}`);
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
  });

  function takeBatch(): Batch {
    const batch = { usage: [...usage.entries()], failures: failures.splice(0) };
    usage.clear();
    bufferFull = false;
    return batch;
  }

  function send(type: "report" | "close", extra: Record<string, unknown>) {
    const id = ++requestId;
    return new Promise<any>((resolve, reject) => {
      if (workerExited) return reject(new Error("Query analytics worker is unavailable"));
      requests.set(id, { resolve, reject });
      worker.postMessage({ type, id, batch: takeBatch(), ...extra });
    });
  }

  function flush() {
    if (closed || (!usage.size && !failures.length)) return;
    worker.postMessage({ type: "flush", batch: takeBatch() });
  }
  const timer = setInterval(flush, 1_000).unref();

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
    if (failures.length >= maxBufferedFailures) flush();
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

  async function report(limit: number) {
    if (closed) throw new Error("Query analytics is closed");
    return send("report", { limit });
  }

  async function close() {
    if (closed) return;
    clearInterval(timer);
    const result = await send("close", { deadlineMs: 5_000 });
    closed = true;
    if (result.spooled) log.warn("Buffered query analytics were spooled during shutdown");
    await worker.terminate();
  }

  return { record, report, close };
}

export type QueryAnalytics = ReturnType<typeof createQueryAnalytics>;
