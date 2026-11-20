import Fastify, { type FastifyBaseLogger } from "fastify";
import compress from "@fastify/compress";

import { registerPlugins } from "./plugins/index.js";
import { registerMiddlewares } from "./middleware/index.js";
import { registerRoutes } from "./routes/index.js";
import { createGatewayLogger } from "./plugins/logger.js";

export async function buildApp() {
  const { logger, close } = createGatewayLogger();
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({ loggerInstance });
  app.addHook("onClose", close);
  app.log.info("Logger initialized");

  try {
    await registerPlugins(app);
    await app.register(compress, { threshold: 1024 });
    await registerMiddlewares(app);
    await registerRoutes(app);
  } catch (error) {
    await app.close().catch(() => {});
    await close().catch(() => {});
    throw error;
  }

  return app;
}
