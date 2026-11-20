import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import authPlugin, {
  verifyAdminPassword,
  hashPassword,
  verifyPassword,
} from "../src/middleware/authentications.js";
import jsondbPlugin, { JsonDB } from "../src/plugins/jsondb.js";
import { createApiKey } from "../src/utils/api-key.js";

const TEST_DIR = resolve(process.cwd(), "test-scratch-auth");
const TEST_DB_PATH = resolve(TEST_DIR, "data.json");

describe("Admin Authentication and Route Gating", () => {
  let app: FastifyInstance;
  let jsondb: JsonDB;
  const adminPassword = "super-secret-admin-pass";

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    jsondb = new JsonDB(TEST_DB_PATH);
    const hash = await hashPassword(adminPassword);
    await jsondb.write({
      admin: { hash },
      apiKeys: {},
    });

    // Create a valid API key for non-admin route tests
    const dummyPgPool = {
      query: async () => ({ rowCount: 1 }),
    } as any;

    await createApiKey(
      {
        database: "mydb",
        environment: "LIVE",
        db: jsondb,
        pgPool: dummyPgPool,
      },
    );

    app = Fastify();
    await app.register(jsondbPlugin, { path: TEST_DB_PATH });
    await app.register(authPlugin);

    // Register routes to test authentication middleware
    app.get("/admin", async (request) => {
      return { success: true, admin: request.admin };
    });

    app.get("/admin/keys", async (request) => {
      return { success: true, admin: request.admin };
    });

    app.get("/api/data", async (request) => {
      return { success: true, db: request.apiKey?.database, admin: request.admin };
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("hashPassword generates valid scrypt hash and verifyPassword matches", async () => {
    const pass = "test-password-123";
    const hash = await hashPassword(pass);

    assert.ok(hash.startsWith("scrypt$"));
    const parts = hash.split("$");
    assert.equal(parts.length, 3);

    const matches = await verifyPassword(pass, hash);
    assert.equal(matches, true);

    const wrongMatches = await verifyPassword("wrong-password", hash);
    assert.equal(wrongMatches, false);
  });

  test("verifyPassword rejects malformed hashes safely", async () => {
    assert.equal(await verifyPassword("test", "invalid-hash"), false);
    assert.equal(await verifyPassword("test", "bcrypt$salt$hash"), false);
    assert.equal(await verifyPassword("test", "scrypt$salt"), false);
  });

  test("verifyAdminPassword matches against jsondb stored hash", async () => {
    const isValid = await verifyAdminPassword(adminPassword, jsondb);
    assert.equal(isValid, true);

    const isInvalid = await verifyAdminPassword("wrong-admin-pass", jsondb);
    assert.equal(isInvalid, false);
  });

  test("Valid admin credentials on /admin route succeed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: {
        "x-admin": adminPassword,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.admin, true);
  });

  test("Valid admin credentials on /admin/* route succeed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/keys?sort=desc",
      headers: {
        "x-admin": adminPassword,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.admin, true);
  });

  test("Invalid admin credentials on /admin/* route return 401 error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: {
        "x-admin": "wrong-password",
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.message, "error");
  });

  test("Missing admin credentials on /admin/* route return 401 error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/keys",
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.message, "error");
  });

  test("Admin credentials on non-admin route do not continue / bypass API key", async () => {
    // Calling /api/data with only x-admin (no x-api-key)
    const res = await app.inject({
      method: "GET",
      url: "/api/data",
      headers: {
        "x-admin": adminPassword,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.message, "error");
  });

  test("Non-admin route with valid x-api-key and x-database succeeds", async () => {
    const data = await jsondb.read();
    const apiKeyRecord = Object.values(data.apiKeys ?? {})[0];
    assert.ok(apiKeyRecord);

    // Retrieve created API key for "mydb"
    const dummyPgPool = {
      query: async () => ({ rowCount: 1 }),
    } as any;
    const { apiKey } = await createApiKey({
      database: "mydb",
      environment: "LIVE",
      db: jsondb,
      pgPool: dummyPgPool,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/data",
      headers: {
        "x-api-key": apiKey,
        "x-database": "mydb",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.db, "mydb");
  });

  test("Non-admin route without database returns 400 error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/data",
      headers: {
        "x-api-key": "KEY_LIVE_somekey1234567890",
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.message, "error");
  });
});
