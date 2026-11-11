import {completeBuild, resolveRelease, type BuildOptions} from '@everock/sdk/build';
/**
 * Wrap your Next config so the client bundle gets the public key + route prefix
 * without any NEXT_PUBLIC_ juggling, and our source packages get transpiled:
 *
 *   // next.config.ts
 *   import { withEverock } from '@everock/next/config';
 *   export default withEverock({});
 */
interface NextConfigish {
  transpilePackages?: string[];
  env?: Record<string, string>;
  compiler?: {runAfterProductionCompile?: (metadata: {distDir: string; projectDir: string}) => void | Promise<void>; [key: string]: unknown};
  [key: string]: unknown;
}

export function withEverock(nextConfig: NextConfigish = {}, options: BuildOptions = {}): NextConfigish {
  const release = options.release ?? resolveRelease();
  const upload = options.uploadSourceMaps !== false && Boolean(options.apiKey ?? process.env.EVEROCK_API_KEY);
  const prior = nextConfig.compiler?.runAfterProductionCompile;
  const prefix = process.env.NEXT_PUBLIC_EVEROCK_ROUTE_PREFIX || '/api/everock';
  return {
    ...nextConfig,
    ...(upload ? {productionBrowserSourceMaps: true} : {}),
    compiler: {...nextConfig.compiler, runAfterProductionCompile: async metadata => {
      await prior?.(metadata);
      await completeBuild({...options, release, root: metadata.projectDir, dir: `${metadata.distDir}/static`, urlPrefix: `${String(nextConfig.basePath ?? '')}/_next/static`});
    }},
    // Consumed from source (the SDK ships TS); let Next transpile it.
    transpilePackages: [
      ...(nextConfig.transpilePackages ?? []),
      '@everock/next',
      '@everock/sdk',
    ],
    // Bake server-side EVEROCK_* env into the client bundle so the provider
    // needs no props. Only the public key ever reaches the browser.
    env: {
      ...nextConfig.env,
      NEXT_PUBLIC_EVEROCK_PUBLIC_KEY: options.publicKey ?? process.env.EVEROCK_PUBLIC_KEY ?? '',
      NEXT_PUBLIC_EVEROCK_ROUTE_PREFIX: prefix,
      NEXT_PUBLIC_EVEROCK_ENVIRONMENT: options.environment ?? process.env.EVEROCK_ENVIRONMENT ?? '',
      NEXT_PUBLIC_EVEROCK_COMPONENT: options.component ?? process.env.EVEROCK_COMPONENT ?? '',
      NEXT_PUBLIC_EVEROCK_RELEASE: release ?? '',
      EVEROCK_RELEASE: release ?? '',
    },
    // The compiler hook uploads after compilation; API keys stay in the Node build process.
  };
}
