import type { FastifyInstance } from 'fastify';

/** Register a 404 handler that does not log or return the unmatched request target. */
export function installPrivacySafeNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    request.log.info({ method: request.method }, 'Route not found');
    return reply.code(404).send({
      message: 'Route not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });
}
