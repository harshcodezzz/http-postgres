import { appendFile, mkdir, open, readdir, realpath, rename, stat, truncate, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const auditFileBytes = 5 * 1024 * 1024;
const tailBytes = 1024 * 1024;
const chunkBytes = 16 * 1024;
const auditOperations = new Map<string, Promise<void>>();

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function withAuditFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (auditOperations.get(path) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => {}, () => {});
  auditOperations.set(path, settled);
  void settled.then(() => {
    if (auditOperations.get(path) === settled) auditOperations.delete(path);
  });
  return result;
}

export async function appendAuditLine(path: string, line: string) {
  await withAuditFile(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path).then((file) => file.size, (error: unknown) => {
      if (isMissing(error)) return 0;
      throw error;
    });
    if (size > 0 && size + Buffer.byteLength(line) > auditFileBytes) {
      await rename(path, `${path}.1`);
    }
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  }).catch(() => {
    // Audit logging failures must not prevent API key operations.
  });
}

export function readAuditTail(path: string, limit: number) {
  return withAuditFile(path, async () => {
    const current = await readLogTail(path, limit);
    const previous = await readLogTail(`${path}.1`, limit - current.length);
    return [...previous, ...current];
  });
}

export async function clearLogFiles(
  directory: string,
  type: "all" | "audit" | "system" = "all",
): Promise<string[]> {
  const cleared: string[] = [];
  const auditPath = resolve(directory, "api-keys.log");
  const currentLog = resolve(directory, "current.log");

  if (type === "all" || type === "audit") {
    await withAuditFile(auditPath, async () => {
      try {
        await truncate(auditPath, 0);
        cleared.push("api-keys.log");
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
      try {
        await unlink(`${auditPath}.1`);
        cleared.push("api-keys.log.1");
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
    });
  }

  if (type === "all" || type === "system") {
    let activeTargetPath: string | null = null;
    try {
      activeTargetPath = await realpath(currentLog);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }

    if (activeTargetPath) {
      try {
        await truncate(activeTargetPath, 0);
        cleared.push(basename(activeTargetPath));
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
    }

    try {
      const entries = await readdir(directory);
      for (const entry of entries) {
        if (entry.startsWith("api-keys.log")) continue;
        if (entry === "current.log") continue;
        const fullPath = join(directory, entry);
        if (activeTargetPath && resolve(fullPath) === resolve(activeTargetPath)) continue;

        if (
          entry.endsWith(".log") ||
          entry.includes(".log.") ||
          entry.startsWith("failed.") ||
          entry.startsWith("gateway.")
        ) {
          try {
            await unlink(fullPath);
            cleared.push(entry);
          } catch (error: unknown) {
            if (!isMissing(error)) throw error;
          }
        }
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }

  return [...new Set(cleared)];
}

export async function readLogTail(path: string, limit: number): Promise<unknown[]> {
  if (limit <= 0) return [];
  const file = await open(path, "r").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!file) return [];

  try {
    let position = (await file.stat()).size;
    const earliest = Math.max(0, position - tailBytes);
    let separators = 0;
    const chunks: Buffer[] = [];

    while (position > earliest && separators <= limit) {
      const length = Math.min(chunkBytes, position - earliest);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const data = chunk.subarray(0, bytesRead);
      chunks.push(data);
      for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10, i + 1)) separators++;
    }

    const content = Buffer.concat(chunks.reverse());
    const firstSeparator = content.indexOf(10);
    if (position > 0 && firstSeparator < 0) return [];
    const start = position > 0 ? firstSeparator + 1 : 0;
    return content.toString("utf8", start).split("\n").filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
  } finally {
    await file.close();
  }
}
