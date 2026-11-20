import Fastify from "fastify";
import compress from "@fastify/compress";

import { registerPlugins } from "./plugins/index.js";
import { registerMiddlewares } from "./middleware/index.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      serializers: {
        responseTime(milliseconds: unknown) {
          return typeof milliseconds === "number" ? milliseconds.toFixed(3) : milliseconds;
        },
      },
    },
  });

  await registerPlugins(app);
  await app.register(compress, { threshold: 1024 });
  await registerMiddlewares(app);
  await registerRoutes(app);

  return app;
}
