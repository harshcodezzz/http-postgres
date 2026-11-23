import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";

export function createGatewayLogger() {
  const logDirectory = resolve(process.cwd(), "logs");
  mkdirSync(logDirectory, { recursive: true });
  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        level: "info",
        options: {
          destination: 1,
        },
      },
      {
        target: "pino-roll",
        level: "error",
        options: {
          file: resolve(logDirectory, "failed.log"),
          frequency: "daily",
          size: "20m",
          limit: { count: 30 },
          mkdir: true,
          symlink: true,
        },
      },
    ],
  }) as ReturnType<typeof pino.transport> & {
    readonly ready: boolean;
    readonly closed: boolean;
    ref(): void;
  };

  const logger = pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        err(error: unknown) {
          if (!(error instanceof Error)) return pino.stdSerializers.err(error as Error);
          return {
            type: error.name,
            message: error.message,
            stack: error.stack,
            ...("code" in error && typeof error.code === "string" && { code: error.code }),
            ...("severity" in error && { severity: (error as { severity?: unknown }).severity }),
            ...("detail" in error && { detail: (error as { detail?: unknown }).detail }),
            ...("hint" in error && { hint: (error as { hint?: unknown }).hint }),
          };
        },
        responseTime(milliseconds: unknown) {
          return typeof milliseconds === "number" ? milliseconds.toFixed(3) : milliseconds;
        },
      },
      redact: {
        paths: [
          "password",
          "token",
          "authorization",
          "headers.authorization",
          "headers['x-api-key']",
          "headers['x-admin']",
          "headers['authorization']",
          "req.headers['x-api-key']",
          "req.headers['x-admin']",
          "req.headers.authorization",
          "database.url",
          "redis.url",
          "client",
          "*.client",
          "secretKey",
          "*.secretKey",
          "processID",
          "*.processID",
        ],
        censor: "[REDACTED]",
      },
    },
    transport,
  );

  let closing: Promise<void> | undefined;
  async function closeTransport() {
    if (!transport.ready && !transport.closed) await once(transport, "ready");
    if (transport.closed) return;
    transport.ref();
    const closed = once(transport, "close");
    transport.end();
    await closed;
  }

  return { logger, close: () => closing ??= closeTransport() };
}
