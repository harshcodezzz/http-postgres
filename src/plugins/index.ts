import type { FastifyInstance } from "fastify";

import errorHandler from "./error-handler.js";
import notFoundHandler from "./not-found-handler.js";
import databasePlugin from "./database.js";
import redisPlugin from "./redis.js";

export async function registerPlugins(app: FastifyInstance) {
  // Error handling
  await app.register(errorHandler);
  await app.register(notFoundHandler);

  // Infrastructure
  await app.register(databasePlugin);
  await app.register(redisPlugin);
}
