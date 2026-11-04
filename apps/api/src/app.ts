import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerPlatform, requestId, type ApiDeps } from './platform.ts';
import { registerRoutes } from './routes.ts';
import { registerAdminRoutes } from './routes-admin.ts';
import { registerReferenceRoutes } from './routes-reference.ts';
import { registerIngestionRoutes } from './routes-ingestion.ts';

export interface AppOptions {
  logger?: FastifyBaseLogger;
  trustProxyHops?: number;
  bodyLimit?: number;
  /** Extra registrations before boot, used by tests of the route-enforcement hook. */
  configure?: (app: FastifyInstance) => void;
}

export function buildApp(deps: ApiDeps, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    // 07 §3.4 TRUST_PROXY_HOPS: trust exactly that many proxies in front of the process.
    trustProxy: (_address: string, hop: number) => hop < (options.trustProxyHops ?? 1),
    bodyLimit: options.bodyLimit ?? 1_048_576,
    genReqId: (req) => requestId(req.headers['x-request-id']),
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;
  registerPlatform(app, deps);
  registerRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerReferenceRoutes(app, deps);
  registerIngestionRoutes(app, deps);
  options.configure?.(app);
  return app;
}
