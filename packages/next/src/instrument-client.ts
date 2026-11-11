/**
 * Client-side entry. Starts the browser SDK, pointed at the app's own origin
 * so telemetry is proxied through the ingest route (no CORS, past ad-blockers).
 *
 * Usage (optional — the provider calls this for you):
 *   import { init } from '@everock/next/instrument-client';
 *   init({ serviceName: '@acme/storefront' });
 */
import { init as sdkInit, capture, captureError, identify, setConsent, getConsent, type InitOptions } from '@everock/sdk';

export interface EverockClientOptions extends Partial<InitOptions> {
  /** Stable name for this app when you run more than one surface. */
  serviceName?: string;
}

let started = false;

export function init(opts: EverockClientOptions = {}): void {
  if (started || typeof window === 'undefined') return;
  const publicKey = opts.publicKey ?? process.env.NEXT_PUBLIC_EVEROCK_PUBLIC_KEY;
  if (!publicKey) return; // nothing to send to — stay silent
  started = true;
  const prefix = process.env.NEXT_PUBLIC_EVEROCK_ROUTE_PREFIX || '/api/everock';
  const sdkOpts = opts;
  sdkInit({
    ...sdkOpts,
    publicKey,
    component: opts.component ?? (process.env.NEXT_PUBLIC_EVEROCK_COMPONENT || undefined),
    // Proxy through the app's origin unless an explicit endpoint is given.
    endpoint: opts.endpoint ?? prefix,
    environment: opts.environment ?? (process.env.NEXT_PUBLIC_EVEROCK_ENVIRONMENT || undefined),
    release: opts.release ?? (process.env.NEXT_PUBLIC_EVEROCK_RELEASE || undefined),
  });
}

export { capture, captureError, identify, setConsent, getConsent };
