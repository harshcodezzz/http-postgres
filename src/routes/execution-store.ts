import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TransactionOptions } from "./query/options.js";

type TransactionInput = {
  queries: { query: string; parameters: unknown[] }[];
  options: TransactionOptions;
};
type StoredTransactionInput = {
  queries: { query: string }[];
  options: TransactionOptions;
};
export type ExecutionOutcome = { status: number; payload: object };
type FinalStatus = "committed" | "rejected" | "failed" | "unknown";
const pruneBatchSize = 500;
const executionIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const terminalTransactionStatuses = "('committed', 'rejected', 'failed', 'unknown')";
const transactionFinalized = `status IN ${terminalTransactionStatuses} OR deadline <= statement_timestamp()`;
const finalTransactionStatus = `CASE
  WHEN status IN ${terminalTransactionStatuses} THEN status
  WHEN status = 'committing' THEN 'unknown'
  ELSE 'failed'
END`;
const queryFinalized = "outcome IS NOT NULL OR deadline <= statement_timestamp()";
type RemovalState = "removed" | "running";
const saveTombstones = `
  UPDATE http_postgres_gateway.submission_keys AS submission
  SET removed_at = clock_timestamp(), final_status = removed.status
  FROM removed
  WHERE submission.transaction_id = removed.id AND submission.owner = removed.owner
    AND submission.database_oid = removed.database_oid
`;

export interface RemovedExecution {
  id: string;
  lastStatus: FinalStatus | null;
  removedAt: Date | null;
}

export interface SavedSubmission extends RemovedExecution {
  matches: boolean;
  status: string | null;
  expired: boolean;
}
interface StoredTransaction {
  transactionId: string;
  status: string;
  input: StoredTransactionInput | string;
  outcome: ExecutionOutcome | string | null;
  completedQueries: number;
  createdAt: Date;
  updatedAt: Date;
  expired: boolean;
}

function encodePayload(payload: StoredTransactionInput | ExecutionOutcome) {
  // JSONB strings containing base64 also work with non-UTF-8 databases and escaped NULs.
  return JSON.stringify(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
}

function decodePayload<T>(payload: T | string): T {
  return typeof payload === "string"
    ? JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as T
    : payload;
}

function errorFields(outcome: ExecutionOutcome): Record<string, unknown> {
  const error = "error" in outcome.payload ? outcome.payload.error : undefined;
  return error && typeof error === "object" ? error as Record<string, unknown> : {};
}

function errorCode(value: unknown) {
  return typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

export function executionErrorCodes(outcome: ExecutionOutcome) {
  const { code, pgCode } = errorFields(outcome);
  return {
    code: errorCode(code),
    pgCode: typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode) ? pgCode : undefined,
  };
}

function privateOutcome(outcome: ExecutionOutcome): ExecutionOutcome {
  if (outcome.status < 400) return outcome;
  // PostgreSQL diagnostics can quote input values, including bound parameters.
  const { code, pgCode } = executionErrorCodes(outcome);
  const { cause, queryId, queryIndex } = errorFields(outcome);
  const message = code === "QUERY_OUTCOME_UNKNOWN" || code === "TRANSACTION_COMMIT_FAILED"
    ? "The execution outcome could not be confirmed. Verify it before retrying."
    : "Execution failed";
  return {
    status: outcome.status,
    payload: {
      success: false,
      error: {
        code: code ?? "QUERY_EXECUTION_ERROR", message, pgCode, cause: errorCode(cause),
        queryId: typeof queryId === "string" && executionIdPattern.test(queryId) ? queryId : undefined,
        queryIndex: Number.isSafeInteger(queryIndex) ? queryIndex : undefined,
      },
    },
  };
}

function inputHash(input: object) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function canonicalInputHash({ queries, options }: TransactionInput) {
  const normalizedOptions = {
    ...options,
    arrayMode: options.arrayMode === true,
    fullResults: options.fullResults !== false,
    lossless: options.lossless !== false,
  };
  const sortedOptions = Object.entries(normalizedOptions).sort(([a], [b]) => a < b ? -1 : Number(a > b));
  return inputHash({
    // The PostgreSQL driver can send a parameter object as order-sensitive JSON text.
    queries: queries.map(({ query, parameters }) => ({ query, parameters })),
    options: Object.fromEntries(sortedOptions),
  });
}

function missingStorage(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "42P01" || error.code === "3F000");
}

async function retryFinalization(operation: () => Promise<void>) {
  const delays = [0, 100, 500];
  for (const [attempt, waitMs] of delays.entries()) {
    if (waitMs) await delay(waitMs);
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt === delays.length - 1) throw error;
    }
  }
}

export function createExecutionStore(pool: Pool) {
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
          RAISE EXCEPTION 'The execution storage schema must belong to the administrative role';
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
            canonical_hash text,
            transaction_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            removed_at timestamptz,
            final_status text,
            PRIMARY KEY (owner, database_oid, key)
          );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = 'http_postgres_gateway.submission_keys'::pg_catalog.regclass
            AND attname = 'canonical_hash' AND NOT attisdropped
        ) THEN
          ALTER TABLE http_postgres_gateway.submission_keys ADD COLUMN canonical_hash text;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = 'http_postgres_gateway.submission_keys'::pg_catalog.regclass
            AND attname = 'removed_at' AND NOT attisdropped
        ) THEN
          ALTER TABLE http_postgres_gateway.submission_keys
            ADD COLUMN removed_at timestamptz, ADD COLUMN final_status text;
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.async_queries') IS NULL THEN
          CREATE TABLE http_postgres_gateway.async_queries (
            id uuid PRIMARY KEY,
            owner text NOT NULL,
            database_oid text NOT NULL,
            deadline timestamptz NOT NULL,
            outcome jsonb,
            completed_at timestamptz
          );
          CREATE INDEX async_queries_retention_idx ON http_postgres_gateway.async_queries
            (COALESCE(completed_at, deadline));
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.transactions_retention_idx') IS NULL THEN
          CREATE INDEX transactions_retention_idx ON http_postgres_gateway.transactions (updated_at)
            WHERE status IN ('committed', 'rejected', 'failed', 'unknown');
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.transactions_deadline_idx') IS NULL THEN
          CREATE INDEX transactions_deadline_idx ON http_postgres_gateway.transactions (deadline)
            WHERE status NOT IN ${terminalTransactionStatuses};
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.submission_keys_retention_idx') IS NULL THEN
          CREATE INDEX submission_keys_retention_idx ON http_postgres_gateway.submission_keys (created_at);
        END IF;
        IF pg_catalog.to_regclass('http_postgres_gateway.submission_keys_transaction_idx') IS NULL THEN
          CREATE INDEX submission_keys_transaction_idx ON http_postgres_gateway.submission_keys (transaction_id);
        END IF;
      END; $bootstrap$;
    `).catch((error) => {
      ready = undefined;
      throw error;
    });
  }

  async function createQuery(id: string, owner: string, oid: string, windowMs: number) {
    await ensure();
    await pool.query(`
      INSERT INTO http_postgres_gateway.async_queries (id, owner, database_oid, deadline)
      VALUES ($1, $2, $3, clock_timestamp() + $4::integer * interval '1 millisecond')
    `, [id, owner, oid, windowMs]);
  }

  async function finishQuery(id: string, outcome: ExecutionOutcome) {
    const payload = encodePayload(privateOutcome(outcome));
    await retryFinalization(async () => {
      await pool.query(`
        UPDATE http_postgres_gateway.async_queries
        SET outcome = $2, completed_at = clock_timestamp()
        WHERE id = $1 AND outcome IS NULL
      `, [id, payload]);
    });
  }

  async function getQuery(id: string, owner: string, oid: string) {
    if (!executionIdPattern.test(id)) return;
    try {
      const { rows: [record] } = await pool.query<{ outcome: ExecutionOutcome | string | null; finalized: boolean }>(`
        SELECT outcome, (${queryFinalized}) AS finalized
        FROM http_postgres_gateway.async_queries
        WHERE id = $1 AND owner = $2 AND database_oid = $3
      `, [id, owner, oid]);
      if (record) {
        return {
          finalized: record.finalized,
          outcome: record.outcome === null ? null : privateOutcome(decodePayload(record.outcome)),
        };
      }
    } catch (error) {
      if (!missingStorage(error)) throw error;
    }
  }

  async function removeQuery(id: string, owner: string, oid: string) {
    if (!executionIdPattern.test(id)) return;
    try {
      const { rows: [record] } = await pool.query<{ state: RemovalState }>(`
        WITH removed AS (
          DELETE FROM http_postgres_gateway.async_queries
          WHERE id = $1 AND owner = $2 AND database_oid = $3 AND (${queryFinalized})
          RETURNING id
        )
        SELECT 'removed' AS state FROM removed
        UNION ALL
        SELECT 'running' FROM http_postgres_gateway.async_queries
        WHERE id = $1 AND owner = $2 AND database_oid = $3 AND NOT (${queryFinalized})
      `, [id, owner, oid]);
      return record?.state;
    } catch (error) {
      if (!missingStorage(error)) throw error;
    }
  }

  async function getSubmission(owner: string, oid: string, key: string, input: TransactionInput) {
    await ensure();
    const canonicalHash = canonicalInputHash(input);
    const { rows: [existing] } = await pool.query<SavedSubmission & { legacyInput: TransactionInput | string | null }>(`
      SELECT submission.transaction_id AS id, execution.status,
             (submission.input_hash = $4 OR submission.canonical_hash IS NOT DISTINCT FROM $5) AS matches,
             CASE WHEN submission.canonical_hash IS NULL AND submission.input_hash <> $4
               THEN execution.input END AS "legacyInput",
             submission.final_status AS "lastStatus", submission.removed_at AS "removedAt",
             COALESCE(execution.deadline <= statement_timestamp(), false) AS expired
      FROM http_postgres_gateway.submission_keys AS submission
      LEFT JOIN http_postgres_gateway.transactions AS execution ON execution.id = submission.transaction_id
        AND execution.owner = submission.owner AND execution.database_oid = submission.database_oid
      WHERE submission.owner = $1 AND submission.database_oid = $2 AND submission.key = $3
    `, [owner, oid, key, inputHash(input), canonicalHash]);
    if (existing) {
      const { legacyInput, ...submission } = existing;
      const matches = submission.matches ||
        (legacyInput !== null && canonicalInputHash(decodePayload(legacyInput)) === canonicalHash);
      return { ...submission, matches, created: false as const };
    }
  }

  async function create(
    id: string, owner: string, database: string, oid: string, input: TransactionInput, key?: string,
  ) {
    await ensure();
    const storedInput = { queries: input.queries.map(({ query }) => ({ query })), options: input.options };
    const values = [id, owner, database, oid, encodePayload(storedInput)];
    if (key === undefined) {
      await pool.query(`
        INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
        VALUES ($1, $2, $3, $4, 'pending', $5)
      `, values);
    } else {
      const result = await pool.query(`
        WITH claimed AS (
          INSERT INTO http_postgres_gateway.submission_keys (
            owner, database_oid, key, input_hash, canonical_hash, transaction_id
          )
          VALUES ($2, $4, $6, $7, $8, $1)
          ON CONFLICT (owner, database_oid, key) DO NOTHING
          RETURNING transaction_id
        )
        INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
        SELECT transaction_id, $2, $3, $4, 'pending', $5 FROM claimed
      `, [...values, key, inputHash(input), canonicalInputHash(input)]);
      if (result.rowCount === 0) {
        const submission = await getSubmission(owner, oid, key, input);
        if (!submission) throw new Error("The idempotency record could not be read");
        return submission;
      }
    }
    return { id, created: true as const };
  }

  async function advance(
    id: string, previous: string, status: string, completed?: number, outcome?: ExecutionOutcome,
  ) {
    const result = await pool.query(`
      UPDATE http_postgres_gateway.transactions
      SET status = $3, completed = GREATEST(completed, $4), updated_at = clock_timestamp(),
          prepared_outcome = COALESCE($5, prepared_outcome)
      WHERE id = $1 AND status = $2 AND deadline > clock_timestamp()
    `, [id, previous, status, completed ?? null, outcome ? encodePayload(privateOutcome(outcome)) : null]);
    if (result.rowCount !== 1) throw new Error("Transaction execution window expired");
  }

  async function finish(id: string, status: FinalStatus, outcome?: ExecutionOutcome) {
    const payload = outcome ? encodePayload(privateOutcome(outcome)) : null;
    await retryFinalization(async () => {
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
        // A previous attempt may have finished just before the record was deleted.
        if (record && record.status !== status) throw new Error("The stored transaction could not be finalized");
      }
    });
  }

  // A rename changes the label but preserves the database OID.
  async function get(id: string, owner: string, oid: string) {
    if (!executionIdPattern.test(id)) return;
    // Status lookup must not need schema-creation privileges for existing deployments.
    try {
      const { rows } = await pool.query<StoredTransaction>(`
        SELECT id AS "transactionId", status, input,
               CASE WHEN status IN ${terminalTransactionStatuses} THEN outcome END AS outcome,
               completed AS "completedQueries", created_at AS "createdAt", updated_at AS "updatedAt",
               deadline <= clock_timestamp() AS expired
        FROM http_postgres_gateway.transactions
        WHERE id = $1 AND owner = $2 AND database_oid = $3
      `, [id, owner, oid]);
      const record = rows[0];
      if (record) {
        const input = decodePayload(record.input);
        return {
          ...record,
          input: { options: input.options, queries: input.queries.map(({ query }) => ({ query })) },
          outcome: record.outcome === null ? null : privateOutcome(decodePayload(record.outcome)),
        };
      }
    } catch (error) {
      if (!missingStorage(error)) throw error;
    }
  }

  async function getRemoved(id: string, owner: string, oid: string) {
    if (!executionIdPattern.test(id)) return;
    try {
      const { rows: [record] } = await pool.query<RemovedExecution>(`
        SELECT transaction_id AS id,
               to_jsonb(submission)->>'final_status' AS "lastStatus",
               (to_jsonb(submission)->>'removed_at')::timestamptz AS "removedAt"
        FROM http_postgres_gateway.submission_keys AS submission
        WHERE transaction_id = $1 AND owner = $2 AND database_oid = $3
          AND NOT EXISTS (
            SELECT 1 FROM http_postgres_gateway.transactions WHERE id = submission.transaction_id
          )
      `, [id, owner, oid]);
      return record;
    } catch (error) {
      if (!missingStorage(error)) throw error;
    }
  }

  async function remove(id: string, owner: string, oid: string) {
    if (!executionIdPattern.test(id)) return;
    try {
      const { rows: [record] } = await pool.query<{ state: RemovalState }>(`
        WITH removed AS (
          DELETE FROM http_postgres_gateway.transactions
          WHERE id = $1 AND owner = $2 AND database_oid = $3 AND (${transactionFinalized})
          RETURNING id, owner, database_oid, ${finalTransactionStatus} AS status
        ), tombstones AS (${saveTombstones})
        SELECT 'removed' AS state FROM removed
        UNION ALL
        SELECT 'running' FROM http_postgres_gateway.transactions
        WHERE id = $1 AND owner = $2 AND database_oid = $3 AND NOT (${transactionFinalized})
      `, [id, owner, oid]);
      return record?.state;
    } catch (error) {
      if (!missingStorage(error)) throw error;
    }
  }

  async function prune(retentionDays: number) {
    const { rows: [tables] } = await pool.query<{ hasRecords: boolean }>(`
      SELECT pg_catalog.to_regclass('http_postgres_gateway.transactions') IS NOT NULL AS "hasRecords"
    `);
    if (!tables?.hasRecords) return false;
    await ensure();
    const records = await pool.query(`
      WITH expired AS (
        SELECT id FROM http_postgres_gateway.transactions
        WHERE (status IN ${terminalTransactionStatuses}
            AND updated_at <= statement_timestamp() - pg_catalog.make_interval(days => $1))
          OR (status NOT IN ${terminalTransactionStatuses}
            AND deadline <= statement_timestamp() - pg_catalog.make_interval(days => $1))
        ORDER BY CASE WHEN status IN ${terminalTransactionStatuses} THEN updated_at ELSE deadline END
        LIMIT $2 FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM http_postgres_gateway.transactions AS execution
        USING expired WHERE execution.id = expired.id
        RETURNING execution.id, execution.owner, execution.database_oid, ${finalTransactionStatus} AS status
      ), tombstones AS (${saveTombstones})
      SELECT id FROM removed
    `, [retentionDays, pruneBatchSize]);
    const keys = await pool.query(`
      WITH expired AS (
        SELECT owner, database_oid, key FROM http_postgres_gateway.submission_keys AS submission
        WHERE created_at <= statement_timestamp() - pg_catalog.make_interval(days => $1)
          AND (removed_at IS NULL OR removed_at <= statement_timestamp() - pg_catalog.make_interval(days => $1))
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
    const queries = await pool.query(`
      WITH expired AS (
        SELECT id FROM http_postgres_gateway.async_queries
        WHERE COALESCE(completed_at, deadline) <= statement_timestamp() - pg_catalog.make_interval(days => $1)
        ORDER BY COALESCE(completed_at, deadline)
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM http_postgres_gateway.async_queries AS query
      USING expired WHERE query.id = expired.id
    `, [retentionDays, pruneBatchSize]);
    return [records, keys, queries].some(({ rowCount }) => rowCount === pruneBatchSize);
  }

  return { create, getSubmission, advance, finish, get, getRemoved, remove, prune, createQuery, finishQuery, getQuery, removeQuery };
}

export type ExecutionStore = ReturnType<typeof createExecutionStore>;
