import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import YAML from "yaml";
import { z } from "zod";
import { databaseName } from "./query-privileges.js";

loadEnv({ quiet: true });

const ipWhitelistEntry = z.string().refine((entry) => {
  const separator = entry.lastIndexOf("/");
  const address = separator < 0 ? entry : entry.slice(0, separator);
  const version = isIP(address);
  if (!version) return false;
  if (separator < 0) return true;
  const prefix = entry.slice(separator + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}, "Use an IPv4 or IPv6 address, optionally followed by a valid CIDR prefix");

const configSchema = z
  .object({
    version: z.number().int().positive(),

    server: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8080),
    }),

    database: z.object({
      url: z.string().min(1),
      exposeErrorDetails: z.boolean().default(false),
      queryUrls: z
        .record(databaseName, z.string().min(1))
        .default({}),
      pool: z
        .object({
          min: z.number().int().min(0).default(2),
          queryMin: z.number().int().min(0).default(1),
          max: z.number().int().positive().default(20),
          maxGlobalQueries: z.number().int().positive().default(40),
        })
        .prefault({}),
    }),

    redis: z.object({
      enabled: z.boolean().default(true),
      mode: z.enum(["external", "managed"]).default("external"),
      url: z.string().optional(),
    }),

    ratelimit: z
      .object({
        enabled: z.boolean().default(true),
        requestPerMinute: z.number().int().positive().default(1000),
        requestPerMinutePerIp: z.number().int().positive().default(1000),
        whitelistedIPs: z.array(ipWhitelistEntry).default([]),
      })
      .prefault({}),

    transactions: z.object({
      retentionDays: z.number().int().min(0).max(365_000).default(30),
    }).prefault({}),

    analytics: z
      .object({
        enabled: z.boolean().default(true),
        directory: z.string().default("./data/analytics"),
        retentionDays: z.number().int().min(1).max(3650).default(30),
        maxStorageBytes: z.number().int().min(1_048_576).default(67_108_864),
        storeFullSql: z.boolean().default(false),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.database.pool.min > config.database.pool.max) {
      ctx.addIssue({
        code: "custom",
        path: ["database", "pool", "min"],
        message: "Pool minimum cannot exceed pool maximum",
      });
    }
    if (config.database.pool.queryMin > config.database.pool.max) {
      ctx.addIssue({
        code: "custom",
        path: ["database", "pool", "queryMin"],
        message: "Query pool minimum cannot exceed pool maximum",
      });
    }

    if (config.redis.enabled && !config.redis.url) {
      ctx.addIssue({
        code: "custom",
        path: ["redis", "url"],
        message: "Redis URL is required when Redis is enabled",
      });
    }
  });

export type GatewayConfig = z.infer<typeof configSchema>;

function resolveEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback?: string) => {
        const envValue = process.env[name];

        if (envValue !== undefined) return envValue;
        if (fallback !== undefined) return fallback;

        throw new Error(`Missing environment variable: ${name}`);
      },
    );
  }

  if (Array.isArray(value)) {
    return value.map(resolveEnv);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, resolveEnv(val)]),
    );
  }

  return value;
}

export function loadConfig(configPath = "gateway.yaml"): GatewayConfig {
  const absolutePath = resolve(process.cwd(), configPath);

  try {
    const content = readFileSync(absolutePath, "utf8");
    const parsed = YAML.parse(content);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration file must contain a YAML object");
    }

    const resolved = resolveEnv(parsed);
    return configSchema.parse(resolved);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid gateway configuration:\n${z.prettifyError(error)}`,
      );
    }

    throw new Error(
      `Failed to load configuration from ${absolutePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
