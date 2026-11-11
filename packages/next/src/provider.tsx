'use client';

/**
 * Mount once at the root layout to start capturing in the browser:
 *
 *   import { EverockProvider } from '@everock/next/provider';
 *   <EverockProvider>{children}</EverockProvider>
 *
 * Then read the client API anywhere with useEverock().
 */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { init, capture, captureError, identify, setConsent, getConsent, type EverockClientOptions } from './instrument-client.js';

interface EverockApi {
  capture: typeof capture;
  captureError: typeof captureError;
  identify: typeof identify;
  setConsent: typeof setConsent;
  getConsent: typeof getConsent;
}

const Ctx = createContext<EverockApi>({ capture, captureError, identify, setConsent, getConsent });

export function EverockProvider({
  children,
  ...opts
}: EverockClientOptions & { children: ReactNode }) {
  useEffect(() => {
    init(opts);
    // init() is idempotent; re-running on option changes is a no-op after the
    // first call, so we intentionally start once and never tear down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Ctx.Provider value={{ capture, captureError, identify, setConsent, getConsent }}>{children}</Ctx.Provider>;
}

export function useEverock(): EverockApi {
  return useContext(Ctx);
}
