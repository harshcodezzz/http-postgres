import type { Pool } from "pg";

interface StoredTransaction {
  transactionId: string;
  database: string;
  status: string;
  input: { queries: unknown[]; options: unknown };
  outcome: { status: number; payload: object } | null;
  completedQueries: number;
  createdAt: Date;
  updatedAt: Date;
  expired: boolean;
}

export function createTransactionStore(pool: Pool) {
  let ready: Promise<unknown> | undefined;
  function ensure() {
    return ready ??= pool.query(`
      SELECT pg_catalog.pg_advisory_xact_lock(5872016943420101);
      CREATE SCHEMA IF NOT EXISTS http_postgres_gateway;
      DO $ownership$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace
          WHERE nspname = 'http_postgres_gateway'
            AND nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
        ) THEN
          RAISE EXCEPTION 'The transaction storage schema must belong to the administrative role';
        END IF;
      END; $ownership$;
      REVOKE ALL ON SCHEMA http_postgres_gateway FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS http_postgres_gateway.transactions (
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
    `).catch((error) => {
      ready = undefined;
      throw error;
    });
  }

  async function create(id: string, owner: string, database: string, oid: string, input: unknown) {
    await ensure();
    await pool.query(`
      INSERT INTO http_postgres_gateway.transactions (id, owner, database_name, database_oid, status, input)
      VALUES ($1, $2, $3, $4, 'pending', $5)
    `, [id, owner, database, oid, JSON.stringify(input)]);
  }

  async function advance(id: string, previous: string, status: string, completed?: number) {
    const result = await pool.query(`
      UPDATE http_postgres_gateway.transactions
      SET status = $3, completed = COALESCE($4, completed), updated_at = clock_timestamp()
      WHERE id = $1 AND status = $2 AND deadline > clock_timestamp()
    `, [id, previous, status, completed ?? null]);
    if (result.rowCount !== 1) throw new Error("Transaction execution window expired");
  }

  async function finish(id: string, status: string, outcome: unknown) {
    await pool.query(`
      UPDATE http_postgres_gateway.transactions
      SET status = $2, outcome = $3, updated_at = clock_timestamp()
      WHERE id = $1 AND status IN ('pending', 'running', 'committing')
    `, [id, status, JSON.stringify(outcome)]);
  }

  async function get(id: string, owner: string, database: string, oid: string) {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return;
    // Status lookup must not need schema-creation privileges for existing deployments.
    try {
      const { rows } = await pool.query<StoredTransaction>(`
        SELECT id AS "transactionId", database_name AS database, status, input, outcome,
               completed AS "completedQueries", created_at AS "createdAt", updated_at AS "updatedAt",
               deadline <= clock_timestamp() AS expired
        FROM http_postgres_gateway.transactions
        WHERE id = $1 AND owner = $2 AND database_name = $3 AND database_oid = $4
      `, [id, owner, database, oid]);
      return rows[0];
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "42P01" || error.code === "3F000")) return;
      throw error;
    }
  }

  async function remove(id: string, owner: string, database: string, oid: string) {
    const result = await pool.query(`
      DELETE FROM http_postgres_gateway.transactions
      WHERE id = $1 AND owner = $2 AND database_name = $3 AND database_oid = $4
        AND (status NOT IN ('pending', 'running', 'committing') OR deadline <= clock_timestamp())
    `, [id, owner, database, oid]);
    return result.rowCount === 1;
  }

  return { create, advance, finish, get, remove };
}
