/** Build-time only. Never import from a browser entry. Secrets stay in the build process. */
import {execFile, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export interface BuildOptions {
  endpoint?: string;
  publicKey?: string;
  /** CI/server only; never baked into client defines. */
  apiKey?: string;
  release?: string;
  environment?: string;
  component?: string;
  /** Automatic uploads are opt-in through this option or EVEROCK_API_KEY. */
  uploadSourceMaps?: boolean;
  reportRelease?: boolean;
}
export function resolveRelease(root = process.cwd()): string | undefined {
  const env = process.env;
  const configured = env.EVEROCK_RELEASE || env.VERCEL_GIT_COMMIT_SHA || env.CF_PAGES_COMMIT_SHA || env.GITHUB_SHA;
  if (configured) return configured;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000}).trim() || undefined; } catch { return undefined; }
}
export async function completeBuild(options: BuildOptions & {dir: string; urlPrefix: string; root?: string}): Promise<void> {
  const release = options.release ?? resolveRelease(options.root);
  if (!release) return;
  const env = {...process.env, EVEROCK_RELEASE: release,
    ...(options.endpoint ? {EVEROCK_ENDPOINT: options.endpoint} : {}),
    ...(options.publicKey ? {EVEROCK_PUBLIC_KEY: options.publicKey} : {}),
    ...(options.apiKey ? {EVEROCK_API_KEY: options.apiKey} : {}),
    ...(options.component ? {EVEROCK_COMPONENT: options.component} : {}),
    ...(options.environment ? {EVEROCK_ENVIRONMENT: options.environment} : {}),
  };
  const run = (name: string, args: string[]) => new Promise<void>(resolvePromise => {
    execFile(process.execPath, [fileURLToPath(new URL(`../bin/${name}.mjs`, import.meta.url)), ...args], {cwd: options.root, env, timeout: 60000, maxBuffer: 64000}, (error, stdout, stderr) => {
      if (stdout.trim()) console.info(stdout.trim());
      if (stderr.trim()) console.warn(stderr.trim());
      if (error) console.warn(`[Everock] ${name}: delivery did not finish; the build is preserved.`);
      resolvePromise();
    });
  });
  if (options.reportRelease !== false && env.EVEROCK_PUBLIC_KEY) await run('release', []);
  if (options.uploadSourceMaps !== false && env.EVEROCK_API_KEY) await run('sourcemaps', ['--dir', resolve(options.root ?? process.cwd(), options.dir), '--url-prefix', options.urlPrefix]);
}
