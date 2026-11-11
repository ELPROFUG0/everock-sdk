/**
 * Client entry. Call init() once in your app's entry point (e.g. main.tsx),
 * before rendering. Reads the config the plugin baked into the bundle, so no
 * arguments are needed:
 *
 *   import { init } from '@everock/vite/client';
 *   init();
 */
import { init as sdkInit, capture, captureError, identify, setConsent, getConsent, type InitOptions } from '@everock/sdk';

// Injected by the Vite plugin via `define`. Undefined if the plugin isn't set up.
declare const __EVEROCK_CONFIG__:
  | { publicKey: string; component?: string; endpoint?: string; environment?: string; release?: string }
  | null
  | undefined;

let started = false;

export function init(opts: Partial<InitOptions> = {}): void {
  if (started || typeof window === 'undefined') return;
  const baked = typeof __EVEROCK_CONFIG__ !== 'undefined' ? __EVEROCK_CONFIG__ : null;
  const publicKey = opts.publicKey ?? baked?.publicKey;
  if (!publicKey) return; // no key baked and none passed — stay silent
  started = true;
  sdkInit({
    ...opts,
    publicKey,
    component: opts.component ?? baked?.component,
    endpoint: opts.endpoint ?? baked?.endpoint,
    environment: opts.environment ?? baked?.environment,
    release: opts.release ?? baked?.release,
  });
}

export { capture, captureError, identify, setConsent, getConsent };
