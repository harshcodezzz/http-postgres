import bootstrap from "./utils/bootstrap.js";
import { buildApp } from "./app.js";

async function start() {
  await bootstrap();

  const app = await buildApp();

  await app.listen({
    host: "0.0.0.0",
    port: 8080,
  });
}

start().catch((error) => {
  console.error("Gateway startup failed:", error);
  process.exit(1);
});
