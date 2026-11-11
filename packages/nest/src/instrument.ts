/**
 * Server SDK bootstrap. Import it FIRST in main.ts so it wraps the runtime
 * before anything else loads:
 *
 *   import '@everock/nest/instrument';
 *   // ...then bootstrap your Nest app
 *
 * Reads EVEROCK_* env. init() is idempotent, so EverockModule.forRoot()
 * calling it again is a no-op.
 */
import {
  init as nodeInit,
  captureError,
  capture,
  webhook,
  flush,
  withSpan,
  type NodeInitOptions,
} from '@everock/sdk/node';

let started = false;

export function init(opts: Partial<NodeInitOptions> = {}): void {
  if (started) return;
  const publicKey = opts.publicKey ?? process.env.EVEROCK_PUBLIC_KEY;
  if (!publicKey) return; // no key → stay silent
  started = true;
  nodeInit({
    ...opts,
    publicKey,
    endpoint: opts.endpoint ?? process.env.EVEROCK_ENDPOINT,
    environment: opts.environment ?? process.env.EVEROCK_ENVIRONMENT,
    release: opts.release ?? process.env.EVEROCK_RELEASE,
  });
}

// Importing this module for its side effect starts capture straight away.
init();

export { captureError, capture, webhook, flush, withSpan };
