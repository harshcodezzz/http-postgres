import { z } from "zod";

export const resultOptions = z.strictObject({
  lossless: z.boolean().optional(),
  arrayMode: z.boolean().optional(),
  fullResults: z.boolean().optional(),
});

export type ResultOptions = z.infer<typeof resultOptions>;

const isolationLevels = ["read uncommitted", "read committed", "repeatable read", "serializable"] as const;

export const transactionOptions = resultOptions.extend({
  isolationLevel: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
    z.enum(isolationLevels),
  ).optional(),
  readOnly: z.boolean().optional(),
  deferrable: z.boolean().optional(),
});

export type TransactionOptions = z.infer<typeof transactionOptions>;

export function beginStatement(options: TransactionOptions) {
  const modes: string[] = [];
  if (options.isolationLevel) modes.push("ISOLATION LEVEL " + options.isolationLevel.toUpperCase());
  if (options.readOnly !== undefined) modes.push(options.readOnly ? "READ ONLY" : "READ WRITE");
  if (options.deferrable !== undefined) modes.push(options.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  return ["BEGIN", ...modes].join(" ");
}
