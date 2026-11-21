import type { FastifyReply } from "fastify";
import { Query, types, type CustomTypesConfig, type PoolClient, type QueryConfig, type QueryResult } from "pg";
import type { QueryPools } from "../../utils/query-pool.js";

export class ExecutionStopped extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function watchExecution(
  reply: FastifyReply | undefined, deadlineMs: number, pools: Pick<QueryPools, "queryDispatched" | "release">,
) {
  let client: PoolClient | undefined;
  let stopped: ExecutionStopped | undefined;
  let released = false;
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
  const timeOut = () => stop(new ExecutionStopped(
    504, "EXECUTION_DEADLINE_EXCEEDED", "The execution deadline was exceeded",
  ));
  const timer = setTimeout(timeOut, deadlineMs).unref();
  function check() {
    if (reply?.raw.destroyed) disconnected();
    if (performance.now() >= deadline) timeOut();
    if (stopped) throw stopped;
  }
  function wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, interruption.then((error) => { throw error; })]);
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
    get stopped() { return stopped; },
    attach(connection: PoolClient) {
      client = connection;
      if (stopped) release();
      check();
    },
    close() {
      clearTimeout(timer);
      reply?.raw.removeListener("close", disconnected);
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

export function createResultBudget(execution: ReturnType<typeof watchExecution>) {
  const maxBytes = 8 * 1024 * 1024;
  const maxRows = 50_000;
  let bytes = 0;
  let rows = 0;
  function charge(value: unknown) {
    execution.check();
    bytes += Buffer.byteLength(JSON.stringify(value)) + 64;
    if (bytes > maxBytes || rows > maxRows) {
      const error = new ExecutionStopped(413, "RESULT_LIMIT_EXCEEDED", "The query result exceeds its size limit");
      execution.stop(error);
      throw error;
    }
  }
  return {
    async query(client: PoolClient, statement: ResultStatement): Promise<QueryResult | QueryResult[]> {
      const rejectCopy = () => execution.stop(new ExecutionStopped(
        400, "COPY_STREAM_UNSUPPORTED", "COPY FROM STDIN and COPY TO STDOUT are unsupported",
      ));
      client.connection.on("copyInResponse", rejectCopy);
      client.connection.on("copyOutResponse", rejectCopy);
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
        });
      } finally {
        client.connection.removeListener("copyInResponse", rejectCopy);
        client.connection.removeListener("copyOutResponse", rejectCopy);
      }
    },
  };
}
