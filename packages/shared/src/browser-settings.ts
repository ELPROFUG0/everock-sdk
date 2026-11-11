export const BROWSER_PLUGINS = ['replay', 'logs', 'pageEvents', 'rageClick'] as const;
export type BrowserPlugin = typeof BROWSER_PLUGINS[number];
export interface TrackingDomain { domain: string; status: 'pending' | 'connected'; checkedAt: string | null }
export type AppType = 'public-website' | 'app-dashboard';
export interface BrowserSettings { appType?: AppType; configuredStack?: 'nextjs' | 'react' | 'nest' | 'elysia'; plugins: Record<BrowserPlugin, boolean>; domains: TrackingDomain[] }
// Preserve the installed SDK's existing opt-in behavior.
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { plugins: { replay: false, logs: false, pageEvents: false, rageClick: false }, domains: [] };
export function normalizeTrackingDomain(input: string): string | null {
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.length > 253 || !host.includes('.') || /^\d+(\.\d+){3}$/.test(host) || host.split('.').some(p=>!p || p.length>63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))) return null;
    return host;
  } catch { return null; }
}
