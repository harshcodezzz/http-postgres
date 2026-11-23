import config from "./config/index.js";
import bootstrap from "./utils/bootstrap.js";
import { buildApp } from "./app.js";
import { startRoleCleanupWorker } from "./utils/api-key.js";

async function start() {
  const app = await buildApp();

  let isShuttingDown = false;

  try {
    await bootstrap(app.jsondb);

    const stopRoleCleanup = startRoleCleanupWorker(app.jsondb, app.db, app.log);

    app.addHook("preClose", async () => {
      await stopRoleCleanup();
    });

    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        console.error(`Received ${signal} again, forcing exit`);
        process.exit(1);
      }

      isShuttingDown = true;

      app.log.info({ signal }, "Starting graceful shutdown");

      const timeout = setTimeout(() => {
        console.error("Graceful shutdown timed out");
        process.exit(1);
      }, 30_000);

      timeout.unref();

      try {
        await app.close();

        console.log("Server closed gracefully");
        process.exitCode = 0;
      } catch (error) {
        console.error("Graceful shutdown failed", error);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

start().catch((error) => {
  console.error("Gateway startup failed:", error);
  process.exit(1);
});
