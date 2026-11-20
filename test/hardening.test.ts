import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import Fastify from "fastify";
import { Client } from "pg";
import config from "../src/config/index.js";
import { JsonDB } from "../src/plugins/jsondb.js";
import transactionRoutes from "../src/routes/transaction/index.js";
import { createQueryPools } from "../src/utils/query-pool.js";

test("JsonDB read-modify-write serializes across Node processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jsondb-processes-"));
  const path = join(dir, "metadata.json");
  const execute = promisify(execFile);
  const moduleUrl = new URL("../src/plugins/jsondb.ts", import.meta.url).href;
  const source = `
    import { JsonDB } from ${JSON.stringify(moduleUrl)};
    const db = new JsonDB(process.argv[1]);
    await db.update(async (record) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { ...record, count: (record.count ?? 0) + 1 };
    });
  `;
  try {
    await Promise.all(Array.from({ length: 4 }, () =>
      execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path]),
    ));
    assert.equal(await new JsonDB(path).get("count"), 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown COMMIT command tag fails permanently and explicit ROLLBACK allows retry", async () => {
  const app = Fastify();
  let command = "UNKNOWN";
  app.decorate("queryPools", {
    connect: async () => ({
      query: async (sql: string) => ({ command: sql === "COMMIT" ? command : "BEGIN" }),
      release() {},
    }),
  });
  app.addHook("onRequest", async (request) => {
    request.apiKey = { id: "fixture" } as typeof request.apiKey;
    request.database = "fixture";
    request.databaseOid = "1";
  });
  await app.register(transactionRoutes, { prefix: "/transaction" });
  try {
    for (const [tag, status, storedStatus] of [
      ["UNKNOWN", 500, "failed"], ["ROLLBACK", 400, "pending"], ["COMMIT", 200, "committed"],
    ] as const) {
      command = tag;
      const created = await app.inject({ method: "POST", url: "/transaction" });
      const headers = { "transaction-id": created.json().transactionId };
      const commit = () => app.inject({
        method: "POST", url: "/transaction/add", headers, payload: { query: "COMMIT" },
      });
      if (tag === "UNKNOWN") {
        const oversized = await app.inject({
          method: "POST", url: "/transaction/add", headers,
          payload: { query: "SELECT $1", parameters: ["x".repeat(140_000)] },
        });
        assert.equal(oversized.statusCode, 413);
      }
      assert.equal((await commit()).statusCode, status);
      assert.equal((await app.inject({ url: "/transaction", headers })).json().status, storedStatus);
      if (tag === "UNKNOWN") assert.equal((await commit()).statusCode, 409);
    }
  } finally {
    await app.close();
  }
});

test("different databases share the process connection budget and initialize a server timeout", async (t) => {
  const app = Fastify();
  const pools = createQueryPools([], app.log);
  const { pool, queryUrls } = config.database;
  const previous = pool.maxGlobalQueries;
  pool.maxGlobalQueries = 1;
  queryUrls.budget_a = "postgresql://fixture@localhost/budget_a";
  queryUrls.budget_b = "postgresql://fixture@localhost/budget_b";
  t.mock.method(Client.prototype, "connect", (callback) => queueMicrotask(() => callback(null)));
  let finishClose: (() => void) | undefined;
  t.mock.method(Client.prototype, "end", (callback) => { finishClose = callback; });
  const query = t.mock.method(Client.prototype, "query", async function (this: { database: string }) {
    return { rows: [{ name: this.database, oid: "1", safe: true }] };
  });
  try {
    const first = await pools.connect("budget_a", "1");
    assert.ok(query.mock.calls.some(({ arguments: [sql, parameters] }) =>
      typeof sql === "string" && sql.includes("set_config('statement_timeout'") &&
      Array.isArray(parameters) && parameters[0] === "30000",
    ));
    first.release(true);
    await assert.rejects(pools.connect("budget_b", "1"), { code: "QUERY_CONNECTION_LIMIT" });
    finishClose?.();
    const next = await pools.connect("budget_b", "1");
    next.release(true);
    finishClose?.();
  } finally {
    pool.maxGlobalQueries = previous;
    delete queryUrls.budget_a;
    delete queryUrls.budget_b;
    await pools.close();
    await app.close();
  }
});
