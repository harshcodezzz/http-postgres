import { FastifyInstance } from "fastify";

import ipRateLimit from "./ip-rate-limitter.js";
import authPlugin from "./authentications.js";
import rateLimit from "./rate-limiter.js";

export async function registerMiddlewares(app: FastifyInstance) {
  // Middleware pipeline: request → ip ratelimit → auth → rate-limit → routes
  await app.register(ipRateLimit);
  await app.register(authPlugin);
  await app.register(rateLimit);
}
