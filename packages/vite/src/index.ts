import {completeBuild, resolveRelease, type BuildOptions} from '@everock/sdk/build';
/**
 * Vite plugin. Add it to vite.config and it (a) emits source maps so prod
 * stacks symbolicate, and (b) bakes your public key into the client bundle so
 * init() needs no arguments:
 *
 *   // vite.config.ts
 *   import { everock } from '@everock/vite';
 *   export default defineConfig({ plugins: [everock()] });
 *
 * Then start capture once in your entry (main.tsx):
 *   import { init } from '@everock/vite/client';
 *   init();
 *
 * Upload the maps after build:  "build": "vite build && npx everock-sourcemaps"
 */
export interface EverockViteOptions extends BuildOptions {
  publicKey?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  /** Source-map mode for the build. Default 'hidden' (emitted, not referenced). */
  sourcemap?: boolean | 'hidden' | 'inline';
}

// Minimal shape of a Vite plugin — avoids a hard dependency on `vite` types.
interface VitePluginish {
  name: string;
  configResolved(config: {root: string; base: string; command: string; build: {outDir: string; ssr?: unknown}}): void;
  buildEnd(error?: Error): void;
  closeBundle(): Promise<void>;
  config(): { build?: { sourcemap?: boolean | 'hidden' | 'inline' }; define?: Record<string, string> };
}

export function everock(opts: EverockViteOptions = {}): VitePluginish {
  let buildFailed = false;
  let resolved: {root: string; base: string; command: string; build: {outDir: string; ssr?: unknown}} | undefined;
  const release = opts.release ?? resolveRelease();
  const publicKey = opts.publicKey ?? process.env.EVEROCK_PUBLIC_KEY ?? '';
  const baked = publicKey
    ? {
        publicKey,
        component: opts.component ?? process.env.EVEROCK_COMPONENT,
        endpoint: opts.endpoint ?? process.env.EVEROCK_ENDPOINT,
        environment: opts.environment ?? process.env.EVEROCK_ENVIRONMENT,
        release: release,
      }
    : null;
  return {
    name: 'everock',
    buildEnd(error) { buildFailed = Boolean(error); },
    configResolved(config) { resolved = config; },
    async closeBundle() {
      if (buildFailed || !resolved || resolved.command !== 'build' || resolved.build.ssr) return;
      const base = resolved.base === './' || resolved.base === '' ? '' : resolved.base.replace(/\/$/, '');
      await completeBuild({...opts, publicKey, release, root: resolved.root, dir: resolved.build.outDir, urlPrefix: base});
    },
    config() {
      return {
        build: { sourcemap: opts.sourcemap ?? 'hidden' },
        // Replaced at build time; the client reads it in init().
        define: { __EVEROCK_CONFIG__: JSON.stringify(baked) },
      };
    },
  };
}
