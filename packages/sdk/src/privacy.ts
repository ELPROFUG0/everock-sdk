/** A detached, serializable event passed to the application before transmission. */
export type TelemetryEvent = Record<string, unknown>;
export interface PrivacyOptions {
  /** Last local filter. Return null to discard. Exceptions discard the event safely. */
  beforeSend?: (event: TelemetryEvent) => TelemetryEvent | null;
  /** Additional object field names to redact (case insensitive). */
  redactKeys?: string[];
}
const SECRET = /(?:^|[.])(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '[Redacted URL]';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return raw.split(/[?#]/, 1)[0] ?? ''; }
}
/** Never runs getters/toJSON, never mutates application data, and bounds traversal. */
export function sanitize<T>(value: T, options: PrivacyOptions = {}): T {
  const seen = new WeakSet<object>();
  let remainingNodes = 2000, remainingText = 16000;
  const extra = new Set(options.redactKeys?.map(key => key.toLowerCase()));
  function visit(input: unknown, depth: number, key = ''): unknown {
    if (--remainingNodes < 0) return '[Truncated]';
    if (SECRET.test(key) || extra.has(key.toLowerCase())) return '[Redacted]';
    if (typeof input === 'string') {
      const bounded = input.slice(0, Math.max(0, Math.min(8000, remainingText))); remainingText -= bounded.length;
      const text = bounded.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => redactUrl(raw));
      return /^(?:url|href|filename|referer|referrer|path)$/i.test(key) ? redactUrl(text) : text;
    }
    if (input === null || input === undefined || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object') return String(input);
    if (depth >= 12) return '[Truncated]';
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    try {
      if (input instanceof Error) return {name: input.name, message: visit(input.message, depth + 1), stack: visit(input.stack, depth + 1)};
      if (Array.isArray(input)) {
        const items: unknown[] = [];
        for (const item of input.slice(0, 500)) { if (remainingNodes <= 0) break; items.push(visit(item, depth + 1)); }
        return items;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const name of Object.keys(input).slice(0, 200)) {
        if (remainingNodes <= 0) break;
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor && 'value' in descriptor && descriptor.enumerable) output[name.slice(0, 300)] = visit(descriptor.value, depth + 1, name);
      }
      return output;
    } finally { seen.delete(input); }
  }
  try { return visit(value, 0) as T; } catch { return {} as T; }
}
export type DropReason='filtered'|'filter_error'|'oversize'|'serialization';
export function prepareEvent<T extends object>(event:T,options:PrivacyOptions,onDrop?:(reason:DropReason)=>void):T|null{
 let filtered:unknown;
 const safe=sanitize(event,options);
 try{filtered=options.beforeSend?options.beforeSend(safe as TelemetryEvent):safe;}catch{onDrop?.('filter_error');return null;}
 if(!filtered||typeof filtered!=='object'||Array.isArray(filtered)){onDrop?.('filtered');return null;}
 try{
  const result=options.beforeSend?sanitize(filtered,options):safe;
  // Callback filters may edit the contents, but delivery identity must survive retries.
  if((event as any).id)(result as any).id=(event as any).id;
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>46000){onDrop?.('oversize');return null;}
  return result as T;
 }catch{onDrop?.('serialization');return null;}
}
