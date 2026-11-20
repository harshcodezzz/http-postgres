import Fastify from "fastify";
import compress from "@fastify/compress";

import { registerPlugins } from "./plugins/index.js";
import { registerMiddlewares } from "./middleware/index.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await registerPlugins(app);
  await app.register(compress, { threshold: 1024 });
  await registerMiddlewares(app);

  return app;
}
