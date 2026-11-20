import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";

type TransactionInput = { queries: unknown[]; options: unknown };
type TransactionOutcome = { status: number; payload: object };
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
            completed integer NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            deadline timestamptz NOT NULL DEFAULT clock_timestamp() + interval '90 seconds'
          );
        END IF;
      END; $bootstrap$;
    `).catch((error) => {
      ready = undefined;
      throw error;
    });
  }

  async function create(id: string, owner: string, database: string, oid: string, input: TransactionInput) {
    await ensure();
    await pool.query(`
      INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
      VALUES ($1, $2, $3, $4, 'pending', $5)
    `, [id, owner, database, oid, encodePayload(input)]);
  }

  async function advance(
    id: string, previous: string, status: string, completed?: number, outcome?: TransactionOutcome,
  ) {
    const result = await pool.query(`
      UPDATE http_postgres_gateway.transactions
      SET status = $3, completed = COALESCE($4, completed), updated_at = clock_timestamp(),
          outcome = COALESCE($5, outcome)
      WHERE id = $1 AND status = $2 AND deadline > clock_timestamp()
    `, [id, previous, status, completed ?? null, outcome ? encodePayload(outcome) : null]);
    if (result.rowCount !== 1) throw new Error("Transaction execution window expired");
  }

  async function finish(id: string, status: string, outcome?: TransactionOutcome) {
    const payload = outcome ? encodePayload(outcome) : null;
    const delays = [0, 100, 500];
    for (const [attempt, waitMs] of delays.entries()) {
      if (waitMs) await delay(waitMs);
      try {
        await pool.query(`
          UPDATE http_postgres_gateway.transactions
          SET status = $2, outcome = COALESCE($3, outcome), updated_at = clock_timestamp()
          WHERE id = $1 AND status IN ('pending', 'running', 'committing')
        `, [id, status, payload]);
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
               CASE WHEN status <> 'committing' THEN outcome END AS outcome,
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
        AND (status NOT IN ('pending', 'running', 'committing') OR deadline <= clock_timestamp())
    `, [id, owner, oid]);
    return result.rowCount === 1;
  }

  return { create, advance, finish, get, remove };
}
