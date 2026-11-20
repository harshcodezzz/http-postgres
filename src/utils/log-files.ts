import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

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
