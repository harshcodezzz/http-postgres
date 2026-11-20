import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const notFoundHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
    });
  });
};

export default fp(notFoundHandlerPlugin, {
  name: "not-found-handler",
});
