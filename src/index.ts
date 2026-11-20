import config from "./config/index.js";
import bootstrap from "./utils/bootstrap.js";
import { buildApp } from "./app.js";
import { closeApiKeyPool } from "./utils/api-key.js";

async function start() {
  const app = await buildApp();

  await bootstrap();

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
      app.log.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await app.close();
      await closeApiKeyPool();
      app.log.info("Server closed gracefully");
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Error occurred during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });
}

start().catch((error) => {
  console.error("Gateway startup failed:", error);
  process.exit(1);
});
