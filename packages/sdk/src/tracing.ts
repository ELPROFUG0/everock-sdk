/** W3C Trace Context, carried inside our existing event payload (no new ingest format). */
export interface TraceContext { traceId: string; spanId: string; parentSpanId?: string; traceFlags: string; }
function randomHex(length: number): string {
  const values = new Uint8Array(length); crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
}
export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i.exec(value?.trim() ?? '');
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return;
  return {traceId: match[1]!.toLowerCase(), spanId: match[2]!.toLowerCase(), traceFlags: match[3]!.toLowerCase()};
}
export function childSpan(parent?: TraceContext): TraceContext {
  return {traceId: parent?.traceId ?? randomHex(16), spanId: randomHex(8), ...(parent ? {parentSpanId: parent.spanId} : {}), traceFlags: parent?.traceFlags ?? '01'};
}
export function traceparent(span: TraceContext): string { return `00-${span.traceId}-${span.spanId}-${span.traceFlags}`; }
/** Exact origins only: propagation to paid / unrelated third parties is never implicit. */
export function shouldPropagate(raw: string, targets: string[] = [], base?: string): boolean {
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) && (base && url.origin === new URL(base).origin || targets.some(target => new URL(target).origin === url.origin));
  } catch { return false; }
}
export function tracedRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, parent?: TraceContext, targets?: string[], base?: string): {init: RequestInit | undefined; span: TraceContext} {
  const raw = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const existing = parseTraceparent(headers.get('traceparent'));
  const span = existing ?? childSpan(parent);
  if (!existing && shouldPropagate(raw, targets, base) && init?.mode !== 'no-cors' && !(input instanceof Request && input.mode === 'no-cors')) {
    headers.set('traceparent', traceparent(span));
    return {init: {...init, headers}, span};
  }
  return {init, span};
}
