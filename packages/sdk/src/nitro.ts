import type {IncomingMessage, ServerResponse} from 'node:http';
import {requestHandler, captureRequestError, flush} from './node.js';
interface Event {node?: {req: IncomingMessage; res: ServerResponse}; context?: {matchedRoute?: {path?: string}};}
interface NitroApp {
  hooks: {
    hook(name: 'request', callback: (event: Event) => void): unknown;
    hook(name: 'beforeResponse', callback: (event: Event) => void): unknown;
    hook(name: 'error', callback: (error: Error, context: {event?: Event}) => void): unknown;
    hook(name: 'close', callback: () => Promise<void>): unknown;
  };
}
const installed = new WeakSet<object>();
/** Nuxt 3/4 with Nitro 2, Node preset. Edge presets use their Fetch entry point instead. */
export function instrumentNitro(app: NitroApp): void {
  if (installed.has(app)) return;
  installed.add(app);
  const observe = (event: Event) => {
    if (event.node) requestHandler({route:event.context?.matchedRoute?.path})(event.node.req, event.node.res, () => {});
  };
  app.hooks.hook('request', observe);
  app.hooks.hook('beforeResponse', observe);
  app.hooks.hook('error', (error, {event}) => {if(event?.node) captureRequestError(error, event.node.req);});
  app.hooks.hook('close', () => flush());
}
