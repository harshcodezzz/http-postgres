import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { escapeLiteral, type Client, type Pool } from "pg";
import type { CrudOperation, DatabaseAccess } from "../config/query-privileges.js";
import {
  DatabaseError, databaseUrl, getPostgresDatabaseOid, listPostgresTables,
  quoteIdentifier, withPostgresDatabase,
} from "./pg-database.js";

const privileges: Record<CrudOperation, string> = {
  c: "INSERT", r: "SELECT", u: "UPDATE", d: "DELETE",
};

export interface QueryAccess {
  login: string;
  password: string;
}

export function queryAccess(secret: string, token: string): QueryAccess {
  const digest = (purpose: string) => createHmac("sha256", secret)
    .update(purpose).update(token).digest("base64url");
  return { login: `http_pg_${digest("login:")}`, password: digest("password:") };
}

export function scopedQueryUrl(database: string, access: QueryAccess): string {
  const url = databaseUrl(database);
  url.username = access.login;
  url.password = access.password;
  for (const parameter of ["user", "username", "password", "options", "sslcert", "sslkey"]) {
    url.searchParams.delete(parameter);
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

async function grantAccess(
  client: Client,
  database: string,
  role: string,
  grants: Array<{ schema: string; name: string; operations: CrudOperation[] }>,
) {
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${role}`);
  for (const schema of new Set(grants.map((table) => table.schema))) {
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${role}`);
  }
  for (const table of grants) {
    const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    await client.query(`GRANT ${table.operations.map((op) => privileges[op]).join(", ")} ON TABLE ${qualified} TO ${role}`);
  }

  const insertTables = grants.filter((table) => table.operations.includes("c"));
  if (!insertTables.length) return;
  const { rows: sequences } = await client.query<{ schema: string; name: string }>(`
    SELECT DISTINCT n.nspname AS schema, s.relname AS name
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = d.classid
      AND d.deptype IN ('a', 'i') AND d.refobjid IN (
        SELECT pg_catalog.to_regclass(name)
        FROM pg_catalog.unnest($1::text[]) AS tables(name)
      )
  `, [insertTables.map(({ schema, name }) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`)]);
  for (const { schema, name } of sequences) {
    await client.query(`GRANT USAGE ON SEQUENCE ${quoteIdentifier(schema)}.${quoteIdentifier(name)} TO ${role}`);
  }
}

export async function provisionQueryAccess(
  database: string,
  oid: string,
  policy: Omit<DatabaseAccess, "roleToken">,
  secret: string,
  adminPool: Pool,
): Promise<DatabaseAccess> {
  const { rows: [admin] } = await adminPool.query<{ started: string }>(
    "SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::text AS started",
  );
  return withPostgresDatabase(database, async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_catalog");
    const { rows: [target] } = await client.query<{ started: string }>(
      "SELECT EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::text AS started",
    );
    if (target.started !== admin.started || await getPostgresDatabaseOid(database, client) !== oid) {
      throw new DatabaseError("The database changed during API key setup", "DATABASE_SCOPE_CHANGED");
    }

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
    const roleToken = createHash("sha256").update(JSON.stringify([oid, grants])).digest("hex");
    const { login, password } = queryAccess(secret, roleToken);
    const role = quoteIdentifier(login);

    // A policy is immutable once provisioned. Serialize identical role creation across gateway processes.
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [login]);
    const { rowCount } = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname::text = $1", [login]);
    if (!rowCount) {
      await client.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD ${escapeLiteral(passwordVerifier(password))}`);
      await grantAccess(client, database, role, grants);
    }
    const { rows: [access] } = await client.query<{ safe: boolean }>(`
      SELECT (${scopedRoleSafety("$1::pg_catalog.name")})
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database d
        WHERE d.datname <> pg_catalog.current_database() AND d.datallowconn
          AND pg_catalog.has_database_privilege($1::pg_catalog.name, d.oid, 'CONNECT')
      ) AS safe
    `, [login]);
    if (!access.safe) {
      throw new DatabaseError(
        "Remove PUBLIC access to other databases and any PUBLIC application object privileges inherited by the scoped login",
        "UNSAFE_DATABASE_SCOPE",
      );
    }
    await client.query("COMMIT");
    return { ...policy, roleToken };
  });
}

// PostgreSQL ACLs are additive. Reject PUBLIC access paths to application objects
// that would otherwise sit outside the grants created for the policy role.
export function scopedRoleSafety(role: "session_user" | "$1::pg_catalog.name") {
  return `
  NOT pg_catalog.has_database_privilege(${role}, pg_catalog.current_database(), 'CREATE')
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

const scopedCommands = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "TABLE", "VALUES"]);

export function isScopedStatement(sql: string): boolean {
  // Skip SQL whitespace and comments before reading the complete first identifier.
  let start = 0;
  while (start < sql.length) {
    const prefix = sql.slice(start);
    const whitespace = /^[ \t\n\r\f]+/.exec(prefix);
    if (whitespace) {
      start += whitespace[0].length;
    } else if (prefix.startsWith("--")) {
      const line = /[\n\r]/.exec(prefix);
      if (!line) return false;
      start += line.index + 1;
    } else if (prefix.startsWith("/*")) {
      let depth = 1;
      start += 2;
      while (start < sql.length && depth) {
        const pair = sql.slice(start, start + 2);
        if (pair === "/*") depth++;
        if (pair === "*/") depth--;
        start += pair === "/*" || pair === "*/" ? 2 : 1;
      }
      if (depth) return false;
    } else {
      const keyword = /^[a-z0-9_$\u0080-\uffff]+/i.exec(prefix)?.[0];
      return keyword !== undefined && scopedCommands.has(keyword.toUpperCase());
    }
  }
  return false;
}
