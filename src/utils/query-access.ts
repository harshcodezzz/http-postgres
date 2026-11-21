import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { escapeLiteral, type Client, type Pool } from "pg";
import type { CrudOperation, DatabaseAccess } from "../config/query-privileges.js";
import {
  DatabaseError, databaseUrl, listPostgresTables,
  quoteIdentifier, withPostgresDatabase,
} from "./pg-database.js";

const privileges: Record<CrudOperation, string> = {
  c: "INSERT", r: "SELECT", u: "UPDATE", d: "DELETE",
};

export interface QueryAccess {
  login: string;
  password: string;
  readOnly: boolean;
}

export function queryAccess(secret: string, token: string) {
  const digest = (purpose: string) => createHmac("sha256", secret)
    .update(purpose).update(token).digest("base64url");
  return { login: `http_pg_${digest("login:")}`, password: digest("password:") };
}

export function scopedQueryUrl(database: string, access: QueryAccess): string {
  const url = databaseUrl(database);
  url.searchParams.delete("username");
  url.searchParams.delete("options");
  url.searchParams.delete("sslcert");
  url.searchParams.delete("sslkey");
  url.searchParams.set("user", access.login);
  url.searchParams.set("password", access.password);
  if (url.hostname) {
    url.username = access.login;
    url.password = access.password;
  } else {
    url.username = "";
    url.password = "";
  }
  return url.toString();
}

function passwordVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4_096, 32, "sha256");
  const key = (label: string) => createHmac("sha256", salted).update(label).digest();
  const stored = createHash("sha256").update(key("Client Key")).digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${key("Server Key").toString("base64")}`;
}

interface Relation {
  oid: string;
  schema: string;
  name: string;
}

interface TableGrant extends Relation {
  operations: CrudOperation[];
}

async function listInsertSequences(client: Client, grants: readonly TableGrant[]) {
  const insertTables = grants.filter(({ operations }) => operations.includes("c")).map(({ oid }) => oid);
  if (!insertTables.length) return [];
  const { rows } = await client.query<Relation>(`
    WITH sequences AS (
      SELECT d.refobjid AS oid
      FROM pg_catalog.pg_attrdef a
      JOIN pg_catalog.pg_depend d ON d.objid = a.oid
      WHERE a.adrelid = ANY($1::pg_catalog.oid[])
        AND d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
        AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
      UNION
      SELECT d.objid
      FROM pg_catalog.pg_depend d
      WHERE d.refobjid = ANY($1::pg_catalog.oid[])
        AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.refclassid = d.classid AND d.deptype = 'i'
    )
    SELECT s.oid::text, n.nspname AS schema, s.relname AS name
    FROM sequences
    JOIN pg_catalog.pg_class s ON s.oid = sequences.oid AND s.relkind = 'S'
    JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
    ORDER BY s.oid
  `, [insertTables]);
  return rows;
}

async function grantAccess(
  client: Client, database: string, role: string, grants: readonly TableGrant[], sequences: readonly Relation[],
) {
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${role}`);
  const schemas = new Set([...grants, ...sequences].map(({ schema }) => schema));
  for (const schema of schemas) {
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${role}`);
  }
  for (const table of grants) {
    const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    await client.query(`GRANT ${table.operations.map((op) => privileges[op]).join(", ")} ON TABLE ${qualified} TO ${role}`);
  }
  for (const { schema, name } of sequences) {
    await client.query(`GRANT USAGE ON SEQUENCE ${quoteIdentifier(schema)}.${quoteIdentifier(name)} TO ${role}`);
  }
}

async function hasRequestedAccess(
  client: Client, login: string, grants: readonly TableGrant[], sequences: readonly Relation[],
) {
  const permissions = grants.map(({ oid, operations }) => ({ oid, permissions: operations.map((op) => privileges[op]) }));
  const { rows: [access] } = await client.query<{ granted: boolean }>(`
    SELECT pg_catalog.has_database_privilege($1::pg_catalog.name, pg_catalog.current_database(), 'CONNECT')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_to_recordset($2::jsonb) AS expected(oid pg_catalog.oid, permissions text[])
        LEFT JOIN pg_catalog.pg_class c ON c.oid = expected.oid
        CROSS JOIN LATERAL pg_catalog.unnest(expected.permissions) AS requested(privilege)
        WHERE c.oid IS NULL
          OR NOT pg_catalog.has_schema_privilege($1::pg_catalog.name, c.relnamespace, 'USAGE')
          OR NOT pg_catalog.has_table_privilege($1::pg_catalog.name, c.oid, requested.privilege)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest($3::pg_catalog.oid[]) AS expected(oid)
        LEFT JOIN pg_catalog.pg_class c ON c.oid = expected.oid
        WHERE c.oid IS NULL
          OR NOT pg_catalog.has_schema_privilege($1::pg_catalog.name, c.relnamespace, 'USAGE')
          OR NOT pg_catalog.has_sequence_privilege($1::pg_catalog.name, c.oid, 'USAGE')
      ) AS granted
  `, [login, JSON.stringify(permissions), sequences.map(({ oid }) => oid)]);
  return access.granted;
}

async function withRoleProvisioning<T>(
  database: string, oid: string, adminPool: Pool, operation: (client: Client) => Promise<T>,
) {
  const { rows: [admin] } = await adminPool.query<{ started: string }>(
    "SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::text AS started",
  );
  return withPostgresDatabase(database, async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_catalog");
    const { rows: [target] } = await client.query<{ started: string; oid: string }>(`
      SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::text AS started, oid::text AS oid
      FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database() AND NOT datistemplate
    `);
    if (!target || target.started !== admin.started || target.oid !== oid) {
      throw new DatabaseError("The database changed during API key setup", "DATABASE_SCOPE_CHANGED");
    }
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  });
}

async function provisionLogin(
  client: Client, database: string, token: string, secret: string,
  grants: readonly TableGrant[], sequences: readonly Relation[],
) {
  const { login, password } = queryAccess(secret, token);
  const role = quoteIdentifier(login);
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [login]);
  const { rowCount } = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname::text = $1", [login]);
  if (!rowCount) {
    await client.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD ${escapeLiteral(passwordVerifier(password))}`);
    await grantAccess(client, database, role, grants, sequences);
  }
  await client.query(`REVOKE pg_read_all_stats FROM ${role}`).catch(() => {});
  await client.query(`REVOKE pg_read_all_data FROM ${role}`).catch(() => {});
  await client.query(`REVOKE pg_stat_scan_tables FROM ${role}`).catch(() => {});
  if (!await hasRequestedAccess(client, login, grants, sequences)) {
    throw new DatabaseError(
      "The PostgreSQL administrator could not grant all requested database, schema, table, or sequence privileges",
      "INSUFFICIENT_PRIVILEGE",
    );
  }
  const { rows: [access] } = await client.query<{ safe: boolean; inheritanceSafe: boolean }>(`
    SELECT (${scopedRoleSafety("$1::pg_catalog.name")})
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database d
        WHERE d.datname <> pg_catalog.current_database() AND d.datallowconn
          AND pg_catalog.has_database_privilege($1::pg_catalog.name, d.oid, 'CONNECT')
      ) AS safe,
      ${scopedInheritanceSafety("$1::pg_catalog.name")} AS "inheritanceSafe"
  `, [login]);
  if (!access.inheritanceSafe) {
    throw new DatabaseError(
      "An allowed parent table reaches descendants outside the requested privileges",
      "UNSAFE_DATABASE_SCOPE",
    );
  }
  if (!access.safe) {
    throw new DatabaseError(
      "Remove PUBLIC access to other databases and any PUBLIC application object privileges inherited by the scoped login",
      "UNSAFE_DATABASE_SCOPE",
    );
  }
}

export async function provisionQueryAccess(
  database: string,
  oid: string,
  policy: Pick<DatabaseAccess, "database" | "table" | "tables">,
  secret: string,
  adminPool: Pool,
  owner: string,
): Promise<DatabaseAccess> {
  return withRoleProvisioning(database, oid, adminPool, async (client) => {
    const tables = await listPostgresTables(client);
    const tableKey = (table: { schema: string; name: string }) => JSON.stringify([table.schema, table.name]);
    const selected = new Set(policy.tables.map(tableKey));
    const available = new Set(tables.map(tableKey));
    for (const table of policy.tables) {
      if (!available.has(tableKey(table))) {
        throw new DatabaseError(`Table '${table.schema}.${table.name}' was not found in '${database}'`, "TABLE_NOT_FOUND");
      }
    }

    const grants = tables.map((table) => ({
      ...table,
      operations: selected.has(tableKey(table))
        ? [...new Set([...policy.database, ...policy.table])].sort()
        : policy.database,
    })).filter(({ operations }) => operations.length);
    const sequences = await listInsertSequences(client, grants);
    const roleToken = createHash("sha256").update(JSON.stringify([owner, oid, grants, sequences])).digest("hex");
    await provisionLogin(client, database, roleToken, secret, grants, sequences);
    return { ...policy, roleToken, roleOwner: owner };
  });
}

export async function isolateQueryAccess(
  database: string, oid: string, scope: DatabaseAccess, secret: string, adminPool: Pool, owner: string,
): Promise<DatabaseAccess> {
  return withRoleProvisioning(database, oid, adminPool, async (client) => {
    const original = queryAccess(secret, scope.roleToken).login;
    // Copy effective direct grants by OID so a migration cannot include newly added tables.
    const { rows: [role] } = await client.query<{ oid: string; allowed: boolean }>(`
      SELECT oid::text, pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'CONNECT') AS allowed
      FROM pg_catalog.pg_roles WHERE rolname::text = $1
    `, [original]);
    if (!role?.allowed) {
      throw new DatabaseError("The previous database scope needs to be resaved", "DATABASE_SCOPE_UNBOUND");
    }
    const { rows } = await client.query<Relation & { kind: string; granted: string[] }>(`
      SELECT c.oid::text, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
             pg_catalog.array_agg(DISTINCT acl.privilege_type) AS granted
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
      WHERE c.relkind IN ('r', 'p', 'S') AND acl.grantee = $1::pg_catalog.oid
        AND pg_catalog.has_schema_privilege($1::pg_catalog.oid, n.oid, 'USAGE')
      GROUP BY c.oid, n.nspname
      ORDER BY c.oid
    `, [role.oid]);
    const operations = Object.keys(privileges) as CrudOperation[];
    const grants: TableGrant[] = rows.filter(({ kind }) => kind !== "S").map((table) => ({
      oid: table.oid, schema: table.schema, name: table.name,
      operations: operations.filter((op) => table.granted.includes(privileges[op])),
    })).filter((table) => table.operations.length > 0);
    const sequences = rows.filter(({ kind, granted }) => kind === "S" && granted.includes("USAGE"));
    const roleToken = createHash("sha256").update(JSON.stringify([owner, oid, scope.roleToken])).digest("hex");
    await provisionLogin(client, database, roleToken, secret, grants, sequences);
    return { ...scope, roleToken, roleOwner: owner };
  });
}

export async function deprovisionQueryAccess(
  database: string,
  roleToken: string,
  secret: string,
  adminPool?: Pool,
): Promise<void> {
  const { login } = queryAccess(secret, roleToken);
  const role = quoteIdentifier(login);
  try {
    await withPostgresDatabase(database, async (client) => {
      await client.query("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1", [login]).catch(() => {});
      await client.query(`DROP OWNED BY ${role}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    });
  } catch {
    if (adminPool) {
      await adminPool.query("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1", [login]).catch(() => {});
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
  }
}

type SqlRole = "session_user" | "$1::pg_catalog.name";

export function scopedInheritanceSafety(role: SqlRole) {
  // PostgreSQL checks a parent's ACL when a statement expands to descendants.
  // Checking every immediate edge also covers deeper inheritance and partition trees.
  return `NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class parent ON parent.oid OPERATOR(pg_catalog.=) i.inhparent
    JOIN pg_catalog.pg_class child ON child.oid OPERATOR(pg_catalog.=) i.inhrelid
    CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('DELETE'), ('INSERT')) AS required(privilege)
    WHERE parent.relkind IN ('r', 'p', 'f') AND child.relkind IN ('r', 'p', 'f')
      AND (required.privilege OPERATOR(pg_catalog.<>) 'INSERT' OR child.relispartition)
      AND pg_catalog.has_table_privilege(${role}, parent.oid, required.privilege)
      AND NOT pg_catalog.has_table_privilege(${role}, child.oid, required.privilege)
  )`;
}

// PostgreSQL ACLs are additive. Reject PUBLIC access paths to application objects
// that would otherwise sit outside the grants created for the policy role.
export function scopedRoleSafety(role: SqlRole) {
  return `
  NOT pg_catalog.has_database_privilege(${role}, pg_catalog.current_database(), 'CREATE')
  AND NOT pg_catalog.pg_has_role(${role}, 'pg_read_all_stats', 'USAGE')
  AND NOT pg_catalog.pg_has_role(${role}, 'pg_read_all_stats', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(${role}, 'pg_read_all_data', 'USAGE')
  AND NOT pg_catalog.pg_has_role(${role}, 'pg_stat_scan_tables', 'USAGE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname OPERATOR(pg_catalog.=) ${role}
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
    WHERE pg_catalog.has_schema_privilege(${role}, n.oid, 'CREATE')
      AND NOT pg_catalog.pg_is_other_temp_schema(n.oid)
      AND n.oid OPERATOR(pg_catalog.<>) pg_catalog.pg_my_temp_schema()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
    WHERE c.relkind IN ('r','p','v','m','f','S')
      AND c.oid OPERATOR(pg_catalog.>=) 16384
      AND acl.grantee OPERATOR(pg_catalog.=) 0
      AND pg_catalog.has_schema_privilege(${role}, c.relnamespace, 'USAGE')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
    WHERE c.oid OPERATOR(pg_catalog.>=) 16384
      AND acl.grantee OPERATOR(pg_catalog.=) 0
      AND pg_catalog.has_schema_privilege(${role}, c.relnamespace, 'USAGE')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid OPERATOR(pg_catalog.>=) 16384
      AND pg_catalog.has_schema_privilege(${role}, p.pronamespace, 'USAGE')
      AND pg_catalog.has_function_privilege(${role}, p.oid, 'EXECUTE')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_foreign_data_wrapper w
    WHERE pg_catalog.has_foreign_data_wrapper_privilege(${role}, w.oid, 'USAGE')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_foreign_server s
    WHERE pg_catalog.has_server_privilege(${role}, s.oid, 'USAGE')
  )
`;
}
