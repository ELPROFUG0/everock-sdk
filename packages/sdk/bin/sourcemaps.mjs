#!/usr/bin/env node
/**
 * `npx @everock/sdk sourcemaps`  (or `npx everock-sourcemaps`)
 *
 * Run it after your build so production stack traces symbolicate back to your
 * original code:
 *
 *   "build": "next build && npx everock-sourcemaps"
 *
 * It finds the `.js.map` files your bundler emitted, works out the URL each
 * minified file is served at, and uploads the maps to Everock keyed by
 * release. The upload uses your SECRET key (never the public one); with no
 * secret key or no release it skips quietly so it can never fail a build.
 *
 * Env / flags:
 *   EVEROCK_API_KEY   secret key (ik_…). Required — server + CI only.
 *   EVEROCK_ENDPOINT  API base URL (optional).
 *   --release <r>       release id. Defaults to EVEROCK_RELEASE, then the
 *                       Vercel/Cloudflare commit sha.
 *   --dir <path>        build dir to scan. Auto-detects .next / dist / build.
 *   --url-prefix <p>    URL prefix the dir is served under. Auto per framework.
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const env = process.env;
const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function detectRelease() {
  return (
    flag('release') ||
    env.EVEROCK_RELEASE ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.CF_PAGES_COMMIT_SHA ||
    null
  );
}

// Where the maps live + the URL prefix that dir is served under.
function detectTarget() {
  const dir = flag('dir');
  const prefix = flag('url-prefix');
  if (dir) return { dir, prefix: prefix ?? '' };
  if (existsSync('.next/static')) return { dir: '.next/static', prefix: prefix ?? '/_next/static' };
  if (existsSync('dist/assets')) return { dir: 'dist/assets', prefix: prefix ?? '/assets' };
  if (existsSync('dist')) return { dir: 'dist', prefix: prefix ?? '' };
  if (existsSync('build')) return { dir: 'build', prefix: prefix ?? '' };
  return null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(p, out);
    else if (/\.(?:c|m)?js\.map$/.test(p)) out.push(p);
  }
  return out;
}

// Served URL of the minified file a given .map belongs to.
function servedPath(prefix, dir, mapFile) {
  const rel = relative(dir, mapFile).replace(/\.map$/, '').split(sep).join('/');
  return `${prefix.replace(/\/$/, '')}/${rel}`.replace(/\/{2,}/g, '/');
}

async function main() {
  const key = env.EVEROCK_API_KEY || flag('key') || '';
  if (!key.startsWith('ik_')) {
    console.warn('[everock] sourcemaps: no secret key (EVEROCK_API_KEY=ik_…) — skipping.');
    return;
  }
  const release = detectRelease();
  if (!release) {
    console.warn('[everock] sourcemaps: no release (set --release or EVEROCK_RELEASE) — skipping.');
    return;
  }
  const target = detectTarget();
  if (!target || !existsSync(target.dir)) {
    console.warn('[everock] sourcemaps: no build dir found (.next / dist / build) — skipping.');
    return;
  }
  const endpoint = (env.EVEROCK_ENDPOINT || 'https://collector.everock.example').replace(/\/$/, '');

  const mapFiles = walk(target.dir);
  if (mapFiles.length === 0) {
    console.warn(`[everock] sourcemaps: no .js.map under ${target.dir} — skipping.`);
    return;
  }

  const MAX_BYTES = 24 * 1024 * 1024;
  let uploaded = 0, files = [], size = 1024;
  const send = async () => {
    if (!files.length) return true;
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(`${endpoint}/sourcemaps`, {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: {'content-type': 'application/json', 'x-everock-key': key},
          body: JSON.stringify({release, files, component: flag('component') || env.EVEROCK_COMPONENT || 'main'}),
        });
        if (response.ok || !(response.status === 429 || response.status >= 500)) break;
        const header = response.headers.get('retry-after');
        const delay = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 250 * 2 ** attempt;
        await response.body?.cancel();
        if (delay > 5000) break;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
      } catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); }
    }
    if (!response?.ok) { console.warn(`[Everock] sourcemaps: collector unavailable; maps retained locally.`); return false; }
    const receipt = await response.json();
    if (receipt.files !== files.length) { console.warn('[Everock] sourcemaps: incomplete upload receipt; maps retained locally.'); return false; }
    uploaded += files.length; files = []; size = 1024; return true;
  };
  for (const mp of mapFiles) {
    const file = {path: servedPath(target.prefix, target.dir, mp), map: readFileSync(mp, 'utf8')};
    const length = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (length > MAX_BYTES - 1024) { console.warn('[Everock] sourcemaps: map exceeds upload budget; retained locally.'); continue; }
    if (files.length >= 100 || size + length > MAX_BYTES) { if (!await send()) return; }
    files.push(file); size += length;
  }
  if (!await send()) return;
  console.log(`[everock] sourcemaps: uploaded ${uploaded} map(s) for release ${String(release).slice(0, 12)}`);
}

main().catch((e) => console.warn('[everock] sourcemaps:', e?.message ?? e));
