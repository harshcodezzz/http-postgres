import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyError } from "fastify";

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error(error);

    const statusCode = error.statusCode ?? 500;

    return reply.status(statusCode).send({
      success: false,
      error: {
        code: error.code ?? "INTERNAL_SERVER_ERROR",
        message: statusCode >= 500 ? "Internal server error" : error.message,
      },
    });
  });
};

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
