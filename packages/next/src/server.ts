/**
 * Server-side entry. Wire it in instrumentation.ts so Server Components, route
 * handlers, and server actions get captured too:
 *
 *   // instrumentation.ts
 *   import { init } from '@everock/next/server';
 *   export function register() { init(); }
 *   export { onRequestError } from '@everock/next/server';
 */
import {
  init as nodeInit,
  captureError,
  capture,
  webhook,
  flush,
  withSpan,
  withRequest,
  type NodeInitOptions,
} from '@everock/sdk/node';

/** Start the server SDK. Reads EVEROCK_* env when options are omitted. */
export function init(opts: Partial<NodeInitOptions> = {}): void {
  const publicKey = opts.publicKey ?? process.env.EVEROCK_PUBLIC_KEY;
  if (!publicKey) return; // no key → stay silent
  nodeInit({
    ...opts,
    publicKey,
    component: opts.component ?? process.env.EVEROCK_COMPONENT,
    endpoint: opts.endpoint ?? process.env.EVEROCK_ENDPOINT,
    environment: opts.environment ?? process.env.EVEROCK_ENVIRONMENT,
    release: opts.release ?? process.env.EVEROCK_RELEASE,
  });
}

/**
 * Next's official error hook. Re-export it from instrumentation.ts and every
 * server-side error (RSC, route handler, server action) flows to Everock.
 */
export async function onRequestError(
  error: unknown,
  request?: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  if (isNextControlFlow(error)) return;
  captureError(
    error,
    {
      path: request?.path,
      method: request?.method,
      routerKind: context?.routerKind,
      routePath: context?.routePath,
      renderSource: context?.renderSource,
    },
    {
      handled: false,
      mechanism: 'framework_error',
      operation: context?.routePath ?? request?.path,
    },
  );
  await flush();
}

export function isNextControlFlow(error: unknown): boolean {
  const digest = (error as {digest?: unknown} | null)?.digest;
  return typeof digest === 'string' && /^(NEXT_REDIRECT;|NEXT_NOT_FOUND(?:;|$)|NEXT_HTTP_ERROR_FALLBACK;(?:401|403|404)(?:;|$))/.test(digest);
}
/** Wrap server actions without converting redirect/notFound into reported failures. */
export function withServerAction<A extends unknown[], T>(action: (...args: A) => T | Promise<T>, options: {after?: (task: () => Promise<void>) => void} = {}): (...args: A) => Promise<T> {
  return async (...args) => {
    try {
      const result = await withSpan('server.action', async () => {
        try { return {value: await action(...args)}; }
        catch (error) { if (isNextControlFlow(error)) return {controlFlow: error}; throw error; }
      });
      if ('controlFlow' in result) throw result.controlFlow;
      return result.value;
    }
    catch (error) { if (!isNextControlFlow(error)) captureError(error, undefined, {handled: false, mechanism: 'framework_error'}); throw error; }
    finally {
      if (options.after) { try { flushAfterResponse(options.after); } catch { await flush(); } }
      else await flush();
    }
  };
}
/** Register before returning from a serverless invocation (or pass Next's after()). */
export function flushAfterResponse(after: (task: () => Promise<void>) => void): void { after(() => flush()); }
export { captureError, capture, webhook, flush, withSpan, withRequest };
