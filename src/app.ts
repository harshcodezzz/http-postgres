import Fastify, { type FastifyBaseLogger } from "fastify";
import compress from "@fastify/compress";

import { registerPlugins } from "./plugins/index.js";
import { registerMiddlewares } from "./middleware/index.js";
import { registerRoutes } from "./routes/index.js";
import { createGatewayLogger } from "./plugins/logger.js";
import { OperationalMetrics } from "./services/operational-metrics.js";

export async function buildApp() {
  const { logger, close } = createGatewayLogger();
  const loggerInstance: FastifyBaseLogger = logger;

  const app = Fastify({ loggerInstance });
  const metrics = new OperationalMetrics();
  app.decorate("metrics", metrics);
  app.decorateRequest("metricsStartedAt", 0);
  app.decorateRequest("metricsFinished", false);
  app.addHook("onRequest", (request, reply, done) => {
    request.metricsStartedAt = metrics.requestStarted();
    request.metricsFinished = false;
    reply.raw.once("close", () => {
      if (request.metricsFinished) return;
      request.metricsFinished = true;
      metrics.requestFinished(request.metricsStartedAt, reply.statusCode || 499,
        request.routeOptions.url ?? request.url.split("?")[0]);
    });
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    if (!request.metricsFinished) {
      request.metricsFinished = true;
      metrics.requestFinished(request.metricsStartedAt, reply.statusCode,
        request.routeOptions.url ?? request.url.split("?")[0]);
    }
    done();
  });
  app.addHook("onClose", () => metrics.close());

  app.addHook("onClose", close);
  app.log.info("Logger initialized");

  try {
    await registerPlugins(app);

    await app.register(compress, {
      threshold: 4096,
      encodings: ["gzip", "deflate"],
      zlibOptions: {
        level: 1,
      },
      global: true,
    });

    await registerMiddlewares(app);
    await registerRoutes(app);
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }

  return app;
}
