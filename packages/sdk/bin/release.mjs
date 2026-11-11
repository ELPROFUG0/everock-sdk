#!/usr/bin/env node
/**
 * `npx @everock/sdk release`
 *
 * Run this in your build (e.g. "build": "next build && npx @everock/sdk
 * release"). It auto-detects the deploy provider from the env vars Vercel and
 * Cloudflare Pages inject at build time, then reports the release to Everock
 * using the same surface public key your SDK already uses. No OAuth, no
 * webhook URL to paste.
 *
 * Env it reads:
 *   EVEROCK_KEY / EVEROCK_PUBLIC_KEY / NEXT_PUBLIC_EVEROCK_KEY  (pk_…)
 *   EVEROCK_ENDPOINT                                                (optional)
 *   EVEROCK_RELEASE, EVEROCK_ENVIRONMENT, EVEROCK_DEPLOY_PROVIDER (other CI)
 *   Vercel:     VERCEL, VERCEL_ENV, VERCEL_GIT_COMMIT_SHA, VERCEL_GIT_COMMIT_REF,
 *               VERCEL_GIT_COMMIT_MESSAGE, VERCEL_URL
 *   Cloudflare: CF_PAGES, CF_PAGES_COMMIT_SHA, CF_PAGES_BRANCH, CF_PAGES_URL
 */

const env = process.env;

function detect() {
  if (env.VERCEL) {
    return {
      provider: 'vercel',
      sha: env.EVEROCK_RELEASE || env.VERCEL_GIT_COMMIT_SHA,
      message: env.VERCEL_GIT_COMMIT_MESSAGE || 'Vercel deployment',
      ref: env.VERCEL_GIT_COMMIT_REF || null,
      url: env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null,
      environment: env.EVEROCK_ENVIRONMENT || env.VERCEL_ENV || 'production',
    };
  }
  if (env.CF_PAGES) {
    return {
      provider: 'cloudflare',
      sha: env.EVEROCK_RELEASE || env.CF_PAGES_COMMIT_SHA,
      message: 'Cloudflare Pages deployment',
      ref: env.CF_PAGES_BRANCH || null,
      url: env.CF_PAGES_URL || null,
      environment: env.EVEROCK_ENVIRONMENT || 'production',
    };
  }
  if (!env.EVEROCK_RELEASE) return null;
  return {
    provider: env.EVEROCK_DEPLOY_PROVIDER || 'generic',
    sha: env.EVEROCK_RELEASE,
    message: 'Deployment',
    ref: env.EVEROCK_DEPLOY_REF || null,
    url: env.EVEROCK_DEPLOY_URL || null,
    environment: env.EVEROCK_ENVIRONMENT || 'production',
  };
}

async function main() {
  const key =
    env.EVEROCK_KEY || env.EVEROCK_PUBLIC_KEY || env.NEXT_PUBLIC_EVEROCK_KEY || '';
  if (!key.startsWith('pk_')) {
    console.warn('[everock] release: no surface key (EVEROCK_KEY=pk_…) — skipping.');
    return; // never fail the build
  }
  const endpoint = (env.EVEROCK_ENDPOINT || 'https://collector.everock.example').replace(/\/$/, '');

  const info = detect();
  if (!info?.sha) {
    console.warn('[everock] release: no release ID (set EVEROCK_RELEASE) — skipping.');
    return;
  }

  try {
    const res = await fetch(`${endpoint}/release`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'x-everock-key': key },
      body: JSON.stringify({...info,component:env.EVEROCK_COMPONENT||'main'}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[everock] release: report failed (${res.status}) ${body}`);
      return;
    }
    console.log(
      `[everock] release reported — ${info.provider} ${info.sha.slice(0, 7)} (${info.environment})`,
    );
  } catch (err) {
    console.warn(`[everock] release: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
