import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";

const logDirectory = resolve(process.cwd(), "logs");

mkdirSync(logDirectory, { recursive: true });

const loggerPlugin: FastifyPluginAsync = async (app) => {
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
        level: "info",
        options: {
          file: resolve(logDirectory, "gateway.log"),
          frequency: "daily",
          size: "20m",
          mkdir: true,
        },
      },
    ],
  });

  const logger = pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "password",
          "token",
          "authorization",
          "headers.authorization",
          "database.url",
          "redis.url",
        ],
        censor: "[REDACTED]",
      },
    },
    transport,
  );

  app.log = logger;

  app.addHook("onClose", async () => {
    transport.flush();
    await new Promise<void>((resolve, reject) => {
      transport.end();
      transport.on("close", resolve);
      transport.on("error", reject);
    });
  });

  logger.info("Logger initialized");
};

export default fp(loggerPlugin, {
  name: "logger",
});
