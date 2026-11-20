import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type TransactionInput = { queries: unknown[]; options: unknown };
type TransactionOutcome = { status: number; payload: object };
type FinalStatus = "committed" | "rejected" | "failed" | "unknown";
const pruneBatchSize = 500;
interface StoredTransaction {
  transactionId: string;
  status: string;
  input: TransactionInput | string;
  outcome: TransactionOutcome | string | null;
  completedQueries: number;
  createdAt: Date;
  updatedAt: Date;
  expired: boolean;
}

function encodePayload(payload: TransactionInput | TransactionOutcome) {
  // JSONB strings containing base64 also work with non-UTF-8 databases and escaped NULs.
  return JSON.stringify(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
}

function decodePayload<T>(payload: T | string): T {
  return typeof payload === "string"
    ? JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as T
    : payload;
}

function inputHash(input: TransactionInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createTransactionStore(pool: Pool) {
  let ready: Promise<unknown> | undefined;
  function ensure() {
    return ready ??= pool.query(`
      SELECT pg_catalog.pg_advisory_xact_lock(5872016943420101);
      DO $bootstrap$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'http_postgres_gateway'
        ) THEN
          CREATE SCHEMA http_postgres_gateway;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace
          WHERE nspname = 'http_postgres_gateway'
            AND nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
        ) THEN
          RAISE EXCEPTION 'The transaction storage schema must belong to the administrative role';
        END IF;
        REVOKE ALL ON SCHEMA http_postgres_gateway FROM PUBLIC;
        IF pg_catalog.to_regclass('http_postgres_gateway.transactions') IS NULL THEN
          CREATE TABLE http_postgres_gateway.transactions (
            id uuid PRIMARY KEY,
            owner text NOT NULL,
            database_name text NOT NULL,
            database_oid text NOT NULL,
            status text NOT NULL,
            input jsonb NOT NULL,
            outcome jsonb,
            prepared_outcome jsonb,
            completed integer NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            deadline timestamptz NOT NULL DEFAULT clock_timestamp() + interval '90 seconds'
          );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = 'http_postgres_gateway.transactions'::pg_catalog.regclass
            AND attname = 'prepared_outcome' AND NOT attisdropped
        ) THEN
          ALTER TABLE http_postgres_gateway.transactions ADD COLUMN prepared_outcome jsonb;
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.submission_keys') IS NULL THEN
          CREATE TABLE http_postgres_gateway.submission_keys (
            owner text NOT NULL,
            database_oid text NOT NULL,
            key text NOT NULL,
            input_hash text NOT NULL,
            transaction_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY (owner, database_oid, key)
          );
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.transactions_retention_idx') IS NULL THEN
          CREATE INDEX transactions_retention_idx ON http_postgres_gateway.transactions (updated_at)
            WHERE status IN ('committed', 'rejected', 'failed', 'unknown');
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.submission_keys_retention_idx') IS NULL THEN
          CREATE INDEX submission_keys_retention_idx ON http_postgres_gateway.submission_keys (created_at);
        END IF;
      END; $bootstrap$;
    `).catch((error) => {
      ready = undefined;
      throw error;
    });
  }

  async function getSubmission(owner: string, oid: string, key: string, input: TransactionInput) {
    await ensure();
    const { rows: [existing] } = await pool.query<{ id: string; matches: boolean }>(`
      SELECT transaction_id AS id, input_hash = $4 AS matches
      FROM http_postgres_gateway.submission_keys
      WHERE owner = $1 AND database_oid = $2 AND key = $3
    `, [owner, oid, key, inputHash(input)]);
    if (existing) return { ...existing, created: false };
  }

  async function create(
    id: string, owner: string, database: string, oid: string, input: TransactionInput, key?: string,
  ) {
    await ensure();
    const values = [id, owner, database, oid, encodePayload(input)];
    if (key === undefined) {
      await pool.query(`
        INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
        VALUES ($1, $2, $3, $4, 'pending', $5)
      `, values);
    } else {
      const result = await pool.query(`
        WITH claimed AS (
          INSERT INTO http_postgres_gateway.submission_keys (owner, database_oid, key, input_hash, transaction_id)
          VALUES ($2, $4, $6, $7, $1)
          ON CONFLICT (owner, database_oid, key) DO NOTHING
          RETURNING transaction_id
        )
        INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
        SELECT transaction_id, $2, $3, $4, 'pending', $5 FROM claimed
      `, [...values, key, inputHash(input)]);
      if (result.rowCount === 0) {
        const submission = await getSubmission(owner, oid, key, input);
        if (!submission) throw new Error("The idempotency record could not be read");
        return submission;
      }
    }
    return { id, matches: true, created: true };
  }

  async function advance(
    id: string, previous: string, status: string, completed?: number, outcome?: TransactionOutcome,
  ) {
    const result = await pool.query(`
      UPDATE http_postgres_gateway.transactions
      SET status = $3, completed = COALESCE($4, completed), updated_at = clock_timestamp(),
          prepared_outcome = COALESCE($5, prepared_outcome)
      WHERE id = $1 AND status = $2 AND deadline > clock_timestamp()
    `, [id, previous, status, completed ?? null, outcome ? encodePayload(outcome) : null]);
    if (result.rowCount !== 1) throw new Error("Transaction execution window expired");
  }

  async function finish(id: string, status: FinalStatus, outcome?: TransactionOutcome) {
    const payload = outcome ? encodePayload(outcome) : null;
    const delays = [0, 100, 500];
    for (const [attempt, waitMs] of delays.entries()) {
      if (waitMs) await delay(waitMs);
      try {
        const result = await pool.query(`
          UPDATE http_postgres_gateway.transactions
          SET status = $2,
              outcome = CASE WHEN $2 = 'committed' THEN prepared_outcome ELSE $3 END,
              prepared_outcome = NULL, updated_at = clock_timestamp()
          WHERE id = $1 AND status IN ('pending', 'running', 'committing')
            AND ($2 <> 'committed' OR (status = 'committing' AND prepared_outcome IS NOT NULL))
        `, [id, status, payload]);
        if (result.rowCount === 0) {
          const { rows: [record] } = await pool.query<{ status: string }>(`
            SELECT status FROM http_postgres_gateway.transactions WHERE id = $1
          `, [id]);
          if (record?.status !== status) throw new Error("The stored transaction could not be finalized");
        }
        return;
      } catch (error) {
        if (attempt === delays.length - 1) throw error;
      }
    }
  }

  // A rename changes the label but preserves the database OID.
  async function get(id: string, owner: string, oid: string) {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return;
    // Status lookup must not need schema-creation privileges for existing deployments.
    try {
      const { rows } = await pool.query<StoredTransaction>(`
        SELECT id AS "transactionId", status, input,
               CASE WHEN status IN ('committed', 'rejected', 'failed', 'unknown') THEN outcome END AS outcome,
               completed AS "completedQueries", created_at AS "createdAt", updated_at AS "updatedAt",
               deadline <= clock_timestamp() AS expired
        FROM http_postgres_gateway.transactions
        WHERE id = $1 AND owner = $2 AND database_oid = $3
      `, [id, owner, oid]);
      const record = rows[0];
      if (record) {
        return {
          ...record,
          input: decodePayload(record.input),
          outcome: record.outcome === null ? null : decodePayload(record.outcome),
        };
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "42P01" || error.code === "3F000")) return;
      throw error;
    }
  }

  async function remove(id: string, owner: string, oid: string) {
    const result = await pool.query(`
      DELETE FROM http_postgres_gateway.transactions
      WHERE id = $1 AND owner = $2 AND database_oid = $3
        AND status IN ('committed', 'rejected', 'failed', 'unknown')
    `, [id, owner, oid]);
    return result.rowCount === 1;
  }

  async function prune(retentionDays: number) {
    const { rows: [tables] } = await pool.query<{ hasRecords: boolean; hasKeys: boolean }>(`
      SELECT pg_catalog.to_regclass('http_postgres_gateway.transactions') IS NOT NULL AS "hasRecords",
             pg_catalog.to_regclass('http_postgres_gateway.submission_keys') IS NOT NULL AS "hasKeys"
    `);
    if (!tables?.hasRecords) return false;
    const records = await pool.query(`
      WITH expired AS (
        SELECT id FROM http_postgres_gateway.transactions
        WHERE status IN ('committed', 'rejected', 'failed', 'unknown')
          AND updated_at <= statement_timestamp() - pg_catalog.make_interval(days => $1)
        ORDER BY updated_at
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM http_postgres_gateway.transactions AS transaction
      USING expired WHERE transaction.id = expired.id
    `, [retentionDays, pruneBatchSize]);
    if (!tables.hasKeys) return records.rowCount === pruneBatchSize;
    const keys = await pool.query(`
      WITH expired AS (
        SELECT owner, database_oid, key FROM http_postgres_gateway.submission_keys AS submission
        WHERE created_at <= statement_timestamp() - pg_catalog.make_interval(days => $1)
          AND NOT EXISTS (
            SELECT 1 FROM http_postgres_gateway.transactions WHERE id = submission.transaction_id
          )
        ORDER BY created_at
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM http_postgres_gateway.submission_keys AS submission
      USING expired
      WHERE (submission.owner, submission.database_oid, submission.key) =
            (expired.owner, expired.database_oid, expired.key)
    `, [retentionDays, pruneBatchSize]);
    return records.rowCount === pruneBatchSize || keys.rowCount === pruneBatchSize;
  }

  return { create, getSubmission, advance, finish, get, remove, prune };
}
