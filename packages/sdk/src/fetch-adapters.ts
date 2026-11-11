/** Structural adapters: no framework dependency is bundled into the SDK. */
export type RequestWrapper = <A extends unknown[]>(handler: (request: Request, ...args: A) => Response | Promise<Response>, options?: {route?: string}) => (request: Request, ...args: A) => Promise<Response>;

export function createFetchAdapters(withRequest: RequestWrapper) {
  return {
    /** SvelteKit hooks.server.ts: export const handle = svelteKitHandle(); */
    svelteKitHandle() {
      return async <E extends {request: Request; route: {id: string | null}}>({event, resolve}: {event: E; resolve: (event: E) => Response | Promise<Response>}) =>
        withRequest(() => resolve(event), {route: event.route.id ?? undefined})(event.request);
    },
    /** Astro middleware.ts: export const onRequest = astroMiddleware(); */
    astroMiddleware() {
      return async (context: {request: Request; routePattern?: string}, next: () => Response | Promise<Response>) =>
        withRequest(() => next(), {route: context.routePattern})(context.request);
    },
    /** Hono: app.use('*', honoMiddleware()). Resolve the matched route after next(). */
    honoMiddleware() {
      return async (context: {req: {raw: Request; routePath?: string}; res: Response; executionCtx?: {waitUntil(promise: Promise<unknown>): void}}, next: () => Promise<void>) => {
        const options: {route?: string} = {};
        let executionCtx: {waitUntil(promise: Promise<unknown>): void} | undefined;
        try { executionCtx = context.executionCtx; } catch { /* Node Hono has no execution context. */ }
        await withRequest(async (_request: Request, _executionCtx: typeof executionCtx) => {
          await next();
          options.route = context.req.routePath;
          return context.res;
        }, options)(context.req.raw, executionCtx);
      };
    },
  };
}
