import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonDB } from "../src/plugins/jsondb.js";
import {
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  deleteApiKey,
  parseApiKey,
  maskApiKey,
  hashApiKeySecret,
  type ApiKeyRecord,
} from "../src/utils/api-key.js";

const TEST_DIR = resolve(process.cwd(), "test-scratch-apikey");
const TEST_DB_PATH = resolve(TEST_DIR, "data.json");
const TEST_AUDIT_LOG_PATH = resolve(TEST_DIR, "audit.log");

describe("API Key Service", () => {
  let jsondb: JsonDB;
  const mockPool = {
    query: async (_queryText: string, values?: any[]) => {
      const dbName = values?.[0];
      if (dbName === "existing_db" || dbName === "test_db") {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    },
  } as any;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    jsondb = new JsonDB(TEST_DB_PATH);
    await jsondb.write({
      admin: { hash: "scrypt$salt$hash" },
      apiKeys: {},
    });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("1. Valid LIVE key creation, persistence and verification", async () => {
    const { apiKey, record } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.ok(apiKey.startsWith("KEY_LIVE_"));
    assert.equal(record.environment, "LIVE");
    assert.equal(record.database, "existing_db");
    assert.equal(record.status, "active");

    const result = await verifyApiKey("existing_db", apiKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, true);
    assert.equal(result.record?.id, record.id);
  });

  test("2. Valid TEST key creation and verification", async () => {
    const { apiKey, record } = await createApiKey({
      database: "existing_db",
      environment: "TEST",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.ok(apiKey.startsWith("KEY_TEST_"));
    assert.equal(record.environment, "TEST");

    const result = await verifyApiKey("existing_db", apiKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, true);
  });

  test("3. LIVE/TEST environment mismatch", async () => {
    const { apiKey } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    // Mismatched prefix: swap KEY_LIVE_ to KEY_TEST_ with same secret
    const secret = apiKey.slice("KEY_LIVE_".length);
    const tamperedKey = `KEY_TEST_${secret}`;

    const result = await verifyApiKey("existing_db", tamperedKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "ENVIRONMENT_MISMATCH");
  });

  test("4. Invalid key format", async () => {
    const result = await verifyApiKey("existing_db", "INVALID_FORMAT_KEY", {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "INVALID_FORMAT");
  });

  test("5. Unknown key", async () => {
    const unknownKey = "KEY_LIVE_UnknownSecret1234567890abcdef";
    const result = await verifyApiKey("existing_db", unknownKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "KEY_NOT_FOUND");
  });

  test("6. Revoked key rejection", async () => {
    const { apiKey, record } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    const revoked = await revokeApiKey(apiKey, jsondb, TEST_AUDIT_LOG_PATH);
    assert.equal(revoked, true);

    const result = await verifyApiKey("existing_db", apiKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "KEY_REVOKED");
  });

  test("7. Database scope mismatch", async () => {
    const { apiKey } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    const result = await verifyApiKey("test_db", apiKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "DATABASE_MISMATCH");
  });

  test("8. Database does not exist during key creation", async () => {
    await assert.rejects(
      async () => {
        await createApiKey({
          database: "non_existent_db",
          environment: "LIVE",
          db: jsondb,
          pgPool: mockPool,
          auditLogPath: TEST_AUDIT_LOG_PATH,
        });
      },
      {
        name: "ApiKeyError",
        code: "DATABASE_NOT_FOUND",
      },
    );
  });

  test("9. Successful key creation and persistence across JsonDB reload", async () => {
    const { apiKey, record } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    // Create a new JsonDB instance reading from the same file
    const freshDb = new JsonDB(TEST_DB_PATH);
    const result = await verifyApiKey("existing_db", apiKey, {
      db: freshDb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    assert.equal(result.valid, true);
    assert.equal(result.record?.id, record.id);
  });

  test("10. Key deletion / soft revocation via deleteApiKey", async () => {
    const { apiKey } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    const deleted = await deleteApiKey(apiKey, jsondb, {
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });
    assert.equal(deleted, true);

    const result = await verifyApiKey("existing_db", apiKey, {
      db: jsondb,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });
    assert.equal(result.valid, false);
    assert.equal(result.error, "KEY_REVOKED");
  });

  test("11. Concurrent JSONDB updates do not overwrite one another", async () => {
    const count = 10;
    const promises = Array.from({ length: count }, (_, i) =>
      createApiKey({
        database: "existing_db",
        environment: "LIVE",
        db: jsondb,
        pgPool: mockPool,
        auditLogPath: TEST_AUDIT_LOG_PATH,
      }),
    );

    const results = await Promise.all(promises);
    assert.equal(results.length, count);

    const data = await jsondb.read();
    for (const res of results) {
      const parsed = parseApiKey(res.apiKey);
      assert.ok(parsed);
      const hash = hashApiKeySecret(parsed.secret);
      assert.ok(data.apiKeys?.[hash]);
    }
  });

  test("12. Audit logging failure does not break authentication", async () => {
    const { apiKey } = await createApiKey({
      database: "existing_db",
      environment: "LIVE",
      db: jsondb,
      pgPool: mockPool,
      auditLogPath: TEST_AUDIT_LOG_PATH,
    });

    // Provide a read-only or invalid audit log path
    const invalidPath = "/dev/null/forbidden/audit.log";

    const result = await verifyApiKey("wrong_db", apiKey, {
      db: jsondb,
      auditLogPath: invalidPath,
    });

    assert.equal(result.valid, false);
    assert.equal(result.error, "DATABASE_MISMATCH");
  });

  test("13. Audit logs never contain raw secrets or hashes", async () => {
    const logs = await readFile(TEST_AUDIT_LOG_PATH, "utf8");
    const lines = logs.trim().split("\n");
    assert.ok(lines.length > 0);

    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(!("apiKey" in entry));
      assert.ok(!("secret" in entry));
      assert.ok(!("keyHash" in entry));
      assert.ok(!("hash" in entry));
    }
  });
});
