import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { apiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { httpLogger, requestId } from './middleware/request-context';
import { apiRateLimiter } from './middleware/rate-limit';
import { prisma } from './db/prisma';

/**
 * The app is built by a factory rather than created at import time so the
 * integration tests can mount it with supertest without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind a platform proxy (Render, Railway, Fly), the client IP the rate
  // limiter and audit trail record comes from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Server-to-server calls and curl send no Origin header; browsers always
        // do, and those must be on the allowlist.
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // Rejecting with an Error would surface as a 500, which reads as a
        // server fault and pollutes error monitoring. A disallowed origin is a
        // client-side policy decision, so answer without the CORS headers and
        // let the browser block the response.
        callback(null, false);
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestId);
  app.use(httpLogger);

  /**
   * Liveness plus a real database round-trip. A process that is up but cannot
   * reach Postgres is not healthy, and a platform health check should say so.
   */
  app.get('/health', (_req, res) => {
    void prisma
      .$queryRaw`SELECT 1`
      .then(() => {
        res.json({
          status: 'ok',
          service: 'pollux-hr-api',
          environment: env.NODE_ENV,
          database: 'connected',
          timestamp: new Date().toISOString(),
        });
      })
      .catch(() => {
        res.status(503).json({ status: 'degraded', service: 'pollux-hr-api', database: 'unreachable' });
      });
  });

  app.use('/api', apiRateLimiter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
