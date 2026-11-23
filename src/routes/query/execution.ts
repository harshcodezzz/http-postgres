import type { FastifyReply } from "fastify";
import { Query, types, type CustomTypesConfig, type PoolClient, type QueryConfig, type QueryResult } from "pg";
import type { QueryPools } from "../../utils/query-pool.js";
import config from "../../config/index.js";

export class ExecutionStopped extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function watchExecution(
  reply: FastifyReply | undefined, deadlineMs: number,
  pools: Pick<QueryPools, "queryDispatched" | "recordExecutionTimeout" | "release">,
) {
  let client: PoolClient | undefined;
  let stopped: ExecutionStopped | undefined;
  let released = false;
  const closeCleanups: Array<() => void> = [];
  const abort = new AbortController();
  let notifyStop!: (error: ExecutionStopped) => void;
  const interruption = new Promise<ExecutionStopped>((resolve) => { notifyStop = resolve; });
  const deadline = performance.now() + deadlineMs;
  function release() {
    if (!client || released) return;
    released = true;
    pools.release(client, stopped !== undefined);
  }
  function stop(error: ExecutionStopped) {
    if (stopped) return;
    stopped = error;
    abort.abort(error);
    notifyStop(error);
    release();
  }
  const disconnected = () => {
    if (reply && !reply.raw.writableFinished) {
      stop(new ExecutionStopped(499, "REQUEST_DISCONNECTED", "The HTTP caller disconnected"));
    }
  };
  reply?.raw.once("close", disconnected);
  const timeOut = () => {
    pools.recordExecutionTimeout();
    stop(new ExecutionStopped(504, "EXECUTION_DEADLINE_EXCEEDED", "The execution deadline was exceeded"));
  };
  const timer = setTimeout(timeOut, deadlineMs).unref();
  function check() {
    if (reply?.raw.destroyed) disconnected();
    if (performance.now() >= deadline) timeOut();
    if (stopped) throw stopped;
  }
  function wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, interruption.then((error) => { throw error; })]);
  }
  function deferResponseCleanup(cleanup: () => void) {
    if (!reply) {
      closeCleanups.push(cleanup);
      return;
    }
    if (reply.raw.writableFinished || reply.raw.destroyed) {
      cleanup();
      return;
    }
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      reply.raw.removeListener("finish", finish);
      reply.raw.removeListener("close", finish);
      cleanup();
    };
    reply.raw.once("finish", finish);
    reply.raw.once("close", finish);
  }
  return {
    signal: abort.signal,
    stop,
    check,
    wait,
    run<T>(operation: () => Promise<T>): Promise<T> {
      check();
      if (client) pools.queryDispatched(client);
      return wait(operation());
    },
    deferResponseCleanup,
    get stopped() { return stopped; },
    attach(connection: PoolClient) {
      client = connection;
      if (stopped) release();
      check();
    },
    close() {
      clearTimeout(timer);
      reply?.raw.removeListener("close", disconnected);
      for (const cleanup of closeCleanups.splice(0)) cleanup();
      release();
    },
  };
}

export async function hasAssignedTransactionId(client: PoolClient) {
  // Some PostgreSQL built-ins can allocate a write transaction ID even in READ ONLY mode.
  const { rows: [state] } = await client.query<{ assigned: boolean }>(
    "SELECT pg_catalog.txid_current_if_assigned() IS NOT NULL AS assigned",
  );
  return state.assigned;
}

const exactTextTypes = new Set([
  114, 3802, 199, 3807, // JSON and JSONB, including arrays
  1114, 1184, 1115, 1185, // timestamps and timestamp arrays
  1082, 1182, 1186, 1187, // dates, intervals and their arrays
]);
export const losslessTypes: CustomTypesConfig = {
  getTypeParser(oid, format) {
    if (format !== "binary" && exactTextTypes.has(oid)) return (value: string) => value;
    // Parse numeric[] as text[] to preserve the shape and exact decimal strings.
    if (format !== "binary" && (oid as number) === 1231) return types.getTypeParser(1009 as typeof oid, format);
    if (format !== "binary" && ((oid as number) === 1021 || (oid as number) === 1022)) {
      const parseTextArray = types.getTypeParser(1009 as typeof oid, format) as (value: string) => Array<string | null>;
      return (value: string) => parseTextArray(value).map((item) => {
        if (item === null) return null;
        const number = Number(item);
        return Number.isFinite(number) ? number : item;
      });
    }
    if (format !== "binary" && (oid === 700 || oid === 701)) {
      return (value: string) => Number.isFinite(Number(value)) ? Number(value) : value;
    }
    return types.getTypeParser(oid, format);
  },
};

export type ResultStatement = QueryConfig & { rowMode?: "array"; queryMode?: "extended"; query_timeout?: number };

const maxResultBytes = 8 * 1024 * 1024;
const maxBackendMessageBytes = 8 * 1024 * 1024;
const maxConcurrentResultBytes = Math.max(
  512 * 1024 * 1024,
  (config.database?.pool?.maxGlobalQueries || 50) * maxResultBytes,
);
let reservedResultBytes = 0;
const memoryWaiters = new Set<() => void>();

function wakeMemoryWaiters() {
  for (const waiter of memoryWaiters) {
    if (reservedResultBytes + maxResultBytes <= maxConcurrentResultBytes) {
      waiter();
    } else {
      break;
    }
  }
}

async function acquireResultMemory(
  execution: ReturnType<typeof watchExecution>,
  timeoutMs = 5_000,
): Promise<void> {
  execution.check();
  if (reservedResultBytes + maxResultBytes <= maxConcurrentResultBytes) {
    reservedResultBytes += maxResultBytes;
    return;
  }

  const deadline = performance.now() + timeoutMs;
  while (reservedResultBytes + maxResultBytes > maxConcurrentResultBytes) {
    execution.check();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ExecutionStopped(
        503,
        "RESULT_MEMORY_BUSY",
        "Result memory capacity is temporarily exhausted",
      );
    }

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(
          execution.stopped ??
            new ExecutionStopped(
              503,
              "RESULT_MEMORY_BUSY",
              "Result memory capacity is temporarily exhausted",
            ),
        );
      };
      const cleanup = () => {
        memoryWaiters.delete(onWake);
        if (timer) clearTimeout(timer);
        execution.signal.removeEventListener("abort", onAbort);
      };

      memoryWaiters.add(onWake);
      execution.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, Math.min(remaining, 500)).unref();
    });
  }

  reservedResultBytes += maxResultBytes;
}

function releaseResultMemory() {
  reservedResultBytes = Math.max(0, reservedResultBytes - maxResultBytes);
  wakeMemoryWaiters();
}

export function createResultBudget(execution: ReturnType<typeof watchExecution>) {
  const maxRows = 50_000;
  let bytes = 0;
  let rows = 0;
  let reserved = false;
  function charge(value: unknown) {
    execution.check();
    bytes += Buffer.byteLength(JSON.stringify(value)) + 64;
    if (bytes > maxResultBytes || rows > maxRows) {
      const error = new ExecutionStopped(413, "RESULT_LIMIT_EXCEEDED", "The query result exceeds its size limit");
      execution.stop(error);
      throw error;
    }
  }
  return {
    async query(
      client: PoolClient, statement: ResultStatement, onDispatch?: () => void,
    ): Promise<QueryResult | QueryResult[]> {
      if (!reserved) {
        await acquireResultMemory(execution);
        reserved = true;
        execution.deferResponseCleanup(() => {
          if (!reserved) return;
          reserved = false;
          releaseResultMemory();
        });
      }
      const rejectCopy = () => execution.stop(new ExecutionStopped(
        400, "COPY_STREAM_UNSUPPORTED", "COPY FROM STDIN and COPY TO STDOUT are unsupported",
      ));
      const rejectLargeMessage = (message: { name?: string; length?: number; fields?: unknown[] }) => {
        if (message.name !== "dataRow" || typeof message.length !== "number" || message.length <= maxBackendMessageBytes) return;
        // pg emits this hook before it applies type parsers. Discard the raw
        // fields so an oversized value cannot expand further during decoding.
        if (message.fields) message.fields.length = 0;
        execution.stop(new ExecutionStopped(
          413, "RESULT_MESSAGE_LIMIT_EXCEEDED", "A PostgreSQL result message exceeds the size limit",
        ));
      };
      client.connection.on("copyInResponse", rejectCopy);
      client.connection.on("copyOutResponse", rejectCopy);
      client.connection.on("message", rejectLargeMessage);
      try {
        return await new Promise((resolve, reject) => {
          const query = new Query(statement, (error, result) => {
            if (error) return reject(error);
            try {
              for (const item of Array.isArray(result) ? result : [result]) charge(item.fields ?? []);
              resolve(result);
            } catch (cause) { reject(cause); }
          });
          query.on("row", (row) => {
            if (execution.stopped) return;
            try {
              rows++;
              charge(row);
            } catch (error) { reject(error); }
          });
          // The driver reads the timeout from the submitted Query instance.
          if (statement.query_timeout !== undefined) Object.assign(query, { query_timeout: statement.query_timeout });
          client.query(query);
          onDispatch?.();
        });
      } finally {
        client.connection.removeListener("copyInResponse", rejectCopy);
        client.connection.removeListener("copyOutResponse", rejectCopy);
        client.connection.removeListener("message", rejectLargeMessage);
      }
    },
  };
}
