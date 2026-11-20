import type { FastifyInstance } from "fastify";

import loggerPlugin from "./logger.js";
import errorHandler from "./error-handler.js";
import notFoundHandler from "./not-found-handler.js";
import jsondbPlugin from "./jsondb.js";
import databasePlugin from "./database.js";
import redisPlugin from "./redis.js";

export async function registerPlugins(app: FastifyInstance) {
  // Logging
  await app.register(loggerPlugin);

  // Error handling
  await app.register(errorHandler);
  await app.register(notFoundHandler);

  // Storage & Infrastructure
  await app.register(jsondbPlugin);
  await app.register(databasePlugin);
  await app.register(redisPlugin);
}
