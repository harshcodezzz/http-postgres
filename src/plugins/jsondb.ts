import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { lstat, mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseScopes } from "../config/query-privileges.js";

let sqlite: Promise<typeof import("node:sqlite")> | undefined;

function loadSQLite() {
  // Keep the supported release ranges in sync with package.json.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    throw new Error(`Node.js 22.13+ on the 22.x line or 23.4+ is required. Running ${process.versions.node}.`);
  }
  return sqlite ??= import("node:sqlite").then((module) => {
    if (typeof module.DatabaseSync !== "function") throw new Error("SQLite DatabaseSync is unavailable");
    return module;
  }).catch((cause) => {
    throw new Error("JsonDB requires an enabled node:sqlite module. Use a supported Node.js build and enable SQLite.", { cause });
  });
}

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  databases: string[];
  databaseOids?: Record<string, string>;
  databaseScopes?: DatabaseScopes;
  environment: "LIVE" | "TEST";
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface DataStore {
  admin?: {
    hash: string;
  };
  apiKeys?: Record<string, ApiKeyRecord>;
  [key: string]: unknown;
}

export class JsonDB {
  readonly filePath: string;
  readonly dirPath: string;

  constructor(customPath?: string) {
    this.filePath = resolve(customPath ?? "data/data.json");
    this.dirPath = dirname(this.filePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const { DatabaseSync } = await loadSQLite();
    await mkdir(this.dirPath, { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = performance.now() + 5_000;
    let lock: DatabaseSync | undefined;
    while (!lock) {
      try {
        lock = new DatabaseSync(lockPath);
        lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } catch (error) {
        lock?.close();
        lock = undefined;
        const code = (error as { errcode?: number })?.errcode;
        // SQLITE_BUSY and SQLITE_LOCKED are normal while another writer holds the lock.
        if (code === undefined || ((code & 255) !== 5 && (code & 255) !== 6)) {
          const existing = await lstat(lockPath).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
          });
          // An older gateway uses a directory at this path. Let that writer release it first.
          if (!existing?.isDirectory() && (existing || code !== 14)) throw error;
        }
        if (performance.now() >= deadline) throw new Error(`Timed out acquiring JsonDB lock at ${lockPath}`);
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      // Closing the SQLite connection rolls back the lock transaction. The OS also releases it on exit.
      lock.close();
    }
  }

  private async exists(): Promise<boolean> {
    try {
      await readFile(this.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  }

  async ensureExists(initialData: DataStore = {}): Promise<void> {
    if (await this.exists()) return;
    await this.withLock(async () => {
      if (!(await this.exists())) await this.replace(initialData);
    });
  }

  async read<T = DataStore>(): Promise<T> {
    await this.ensureExists();
    return this.readExisting<T>();
  }

  private async readExisting<T>(): Promise<T> {
    const content = await readFile(this.filePath, "utf8");

    try {
      if (!content.trim()) {
        return {} as T;
      }
      return JSON.parse(content) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON database at ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async write<T = DataStore>(data: T): Promise<void> {
    await this.withLock(() => this.replace(data));
  }

  private async replace<T>(data: T): Promise<void> {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const data = await this.read<Record<string, unknown>>();
    return data[key] as T | undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.update((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async update<T = DataStore>(
    updater: (current: T) => T | Promise<T>,
  ): Promise<T> {
    await this.ensureExists();
    return this.withLock(async () => {
      const current = await this.readExisting<T>();
      const updated = await updater(current);
      await this.replace(updated);
      return updated;
    });
  }
}

declare module "fastify" {
  interface FastifyInstance {
    jsondb: JsonDB;
  }
}

export interface JsonDBPluginOptions {
  path?: string;
  initialData?: DataStore;
}

const jsondbPlugin: FastifyPluginAsync<JsonDBPluginOptions> = async (
  app,
  opts,
) => {
  await loadSQLite();
  const db = new JsonDB(opts.path);

  await db.ensureExists(opts.initialData);

  app.decorate("jsondb", db);

  app.log.info({ path: db.filePath }, "JsonDB initialized");
};

export default fp(jsondbPlugin, {
  name: "jsondb",
});
