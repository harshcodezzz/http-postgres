import { z } from "zod";

export const databaseName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/);

export const crudList = z.array(z.enum(["c", "r", "u", "d"]))
  .transform((operations) => [...new Set(operations)].sort());

export type CrudOperation = z.infer<typeof crudList>[number];

export interface TableName {
  schema: string;
  name: string;
}

export interface DatabaseAccess {
  database: CrudOperation[];
  tables: TableName[];
  table: CrudOperation[];
  roleToken: string;
}
