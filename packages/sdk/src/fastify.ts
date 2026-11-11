import type {IncomingMessage, ServerResponse} from 'node:http';
import {requestHandler, captureRequestError} from './node.js';

interface Request { raw: IncomingMessage; routeOptions?: {url?: string}; }
interface Reply { raw: ServerResponse; }
interface App {
  addHook(name: 'onRequest', hook: (request: Request, reply: Reply, done: () => void) => void): unknown;
  addHook(name: 'onError', hook: (request: Request, reply: Reply, error: Error, done: () => void) => void): unknown;
}
const installed = new WeakSet<object>();
/** Call on the root Fastify instance before registering routes. Initialize the Node SDK first. */
export function instrumentFastify(app: App): void {
  if (installed.has(app)) return;
  installed.add(app);
  app.addHook('onRequest', (request, reply, done) => {
    requestHandler({route: request.routeOptions?.url})(request.raw, reply.raw, done);
  });
  app.addHook('onError', (request, _reply, error, done) => {
    captureRequestError(error, request.raw);
    done();
  });
}
