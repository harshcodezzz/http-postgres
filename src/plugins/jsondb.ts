import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";

import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";

export interface DataStore {
  admin?: {
    hash: string;
  };

  apiKeys?: Record<string, string>;

  [key: string]: unknown;
}

export class JsonDB {
  readonly filePath: string;
  readonly dirPath: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    this.filePath = customPath ?? resolve(process.cwd(), "data", "data.json");

    this.dirPath = dirname(this.filePath);
  }

  async ensureExists(initialData: DataStore = {}): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });

    try {
      await readFile(this.filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await writeFile(this.filePath, JSON.stringify(initialData, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      // Another process may have created the file.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  async read<T = DataStore>(): Promise<T> {
    await this.ensureExists();

    const content = await readFile(this.filePath, "utf8");

    try {
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
    await mkdir(this.dirPath, { recursive: true });

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
    let result!: T;

    const operation = this.writeQueue.then(async () => {
      const current = await this.read<T>();
      const updated = await updater(current);

      await this.write(updated);
      result = updated;
    });

    this.writeQueue = operation.catch(() => {});

    await operation;

    return result;
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
  const db = new JsonDB(opts.path);

  await db.ensureExists(opts.initialData);

  app.decorate("jsondb", db);

  app.log.info({ path: db.filePath }, "JsonDB initialized");
};

export default fp(jsondbPlugin, {
  name: "jsondb",
});
