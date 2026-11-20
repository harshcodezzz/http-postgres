import { z } from "zod";

export const databaseName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/);

const queryPrivileges = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
  "CREATE", "CONNECT", "TEMPORARY", "EXECUTE", "USAGE", "MAINTAIN",
] as const;

export type QueryPrivilege = (typeof queryPrivileges)[number];
export type DatabaseScopes = Record<string, QueryPrivilege[]>;

const privilege = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
  z.enum(queryPrivileges),
);

export const queryScopeList = z.array(privilege)
  .min(1)
  .transform((scopes) => [...new Set(scopes)].sort());

export const databaseScopes = z.record(databaseName, queryScopeList);

export function scopeKey(scopes: readonly QueryPrivilege[]): string {
  return scopes.join(",");
}
