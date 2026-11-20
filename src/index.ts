import config from "./config/index.js";
import bootstrap from "./utils/bootstrap.js";
import { buildApp } from "./app.js";
import { closeApiKeyPool } from "./utils/api-key.js";

async function start() {
  const app = await buildApp();

  await bootstrap(app.jsondb);

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.error(`Received ${signal} during graceful shutdown, forcing exit`);
      process.exit(1);
    }
    isShuttingDown = true;

    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    try {
      await app.close();
      await closeApiKeyPool();
      console.log("Server closed gracefully");
      process.exitCode = 0;
    } catch (error) {
      console.error("Error occurred during graceful shutdown", error);
      process.exitCode = 1;
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
