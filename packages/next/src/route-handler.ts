/**
 * Ingest proxy. Mount at the route that matches your prefix so browser
 * telemetry is sent through your own origin (avoids CORS + ad-blockers):
 *
 *   // app/api/everock/[[...path]]/route.ts
 *   export * from '@everock/next/route-handler';
 */
const ENDPOINT = (process.env.EVEROCK_ENDPOINT || 'https://collector.everock.example').replace(/\/$/, '');

// Only relay what ingest needs — never forward cookies, auth, or the host header.
function relayHeaders(incoming: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const ct = incoming.get('content-type');
  const key = incoming.get('x-everock-key');
  if (ct) out['content-type'] = ct;
  if (key) out['x-everock-key'] = key;
  return out;
}

async function forward(req: Request, path: string): Promise<Response> {
  const body = await req.arrayBuffer();
  try {
    const upstream = await fetch(`${ENDPOINT}/${path}${new URL(req.url).search}`, {
      method: req.method,
      signal: AbortSignal.timeout(5000),
      headers: relayHeaders(req.headers),
      body: body.byteLength ? body : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...(upstream.headers.get('retry-after') ? {'retry-after': upstream.headers.get('retry-after')!} : {}) },
    });
  } catch {
    // Never let a telemetry hiccup surface as an error in the host app.
    return new Response(null, { status: 503, headers: {'retry-after': '1'} });
  }
}

type RouteCtx = { params: Promise<{ path?: string[] }> };

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, (path?.length ? path : ['ingest']).join('/'));
}

// Some transports (replay, beacons) may use GET/OPTIONS — relay them the same way.
export const GET = POST;
export const OPTIONS = POST;
