import {eventId} from './ids.js';
/** Optional OpenTelemetry SpanExporter. It accepts an existing provider; it never replaces one. */
import {DeliveryTransport, takeBatch, type TransportOptions} from './transport.js';
import {prepareEvent, type PrivacyOptions} from './privacy.js';
import {parseTraceparent} from './tracing.js';
import {requestMeasurement} from './request-measurement.js';
// Structural types keep the runtime independent of any particular OTel SDK version.
interface ReadableSpan {
  readonly name: string;
  readonly kind: number;
  readonly spanContext: () => {traceId: string; spanId: string; traceFlags: number};
  readonly parentSpanContext?: {spanId: string};
  readonly parentSpanId?: string;
  readonly startTime: readonly [number, number];
  readonly duration: readonly [number, number];
  readonly status: {code: number; message?: string};
  readonly attributes: Record<string, unknown>;
  readonly events: readonly {name: string; attributes?: Record<string, unknown>}[];
  readonly instrumentationScope?: {name: string; version?: string};
}
export interface SpanExporterOptions extends PrivacyOptions {
  publicKey: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  component?: string;
  serviceName?: string;
  transport?: TransportOptions;
}
interface ExportResult {code: 0 | 1; error?: Error;}
/** Normalize stable and legacy HTTP conventions into the dashboard's HTTP contract. */
function httpMeasurement(span: ReadableSpan) {
  if (span.kind !== 1 && span.kind !== 2) return null;
  const a = span.attributes;
  const method = a['http.request.method'] ?? a['http.method'];
  if (typeof method !== 'string' || !method) return null;
  const target = a['url.full'] ?? a['http.url'] ?? a['url.path'] ?? a['http.target'] ?? a['http.route'];
  if (typeof target !== 'string') return null;
  const rawStatus = a['http.response.status_code'] ?? a['http.status_code'];
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 0;
  const host = a['server.address'] ?? a['http.host'] ?? a['net.peer.name'];
  const measurement = requestMeasurement(target, method, status,
    span.duration[0] * 1000 + span.duration[1] / 1e6, {
      direction: span.kind === 1 ? 'inbound' : 'outbound',
      route: typeof a['http.route'] === 'string' ? a['http.route'] : undefined,
      host: typeof host === 'string' ? host : undefined,
    });
  return measurement ? {...measurement, failed: measurement.failed || span.status.code === 2,
    outcome: status ? 'response' : 'network_error'} : null;
}
/** Compatible with SimpleSpanProcessor and BatchSpanProcessor in OpenTelemetry JS. */
export class EverockSpanExporter {
  private readonly sender = new DeliveryTransport();
  private readonly endpoint: string;
  private events: Record<string, unknown>[] = [];
  private pending: Promise<boolean> | null = null;
  private closed = false;
  constructor(private readonly options: SpanExporterOptions) { this.endpoint = (options.endpoint ?? 'https://collector.everock.example').replace(/\/$/, ''); }
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    if (this.closed || !this.options.publicKey) { callback({code: 1, error: new Error('Everock exporter is not active')}); return; }
    try {
      for (const span of spans) {
        if (this.events.length >= 1000) break;
        const rawUrl = span.attributes['url.full'] ?? span.attributes['http.url'];
        if (typeof rawUrl === 'string' && this.isCollector(rawUrl)) continue;
        const ctx = span.spanContext(), flags = ctx.traceFlags.toString(16).padStart(2, '0');
        if (!parseTraceparent(`00-${ctx.traceId}-${ctx.spanId}-${flags}`)) continue;
        const http = httpMeasurement(span);
        const event = prepareEvent({
          id:eventId(),
          ts: Math.floor(span.startTime[0] * 1000 + span.startTime[1] / 1e6), type: 'trace',
          environment: this.options.environment ?? 'production', release: this.options.release, message: span.name,
          payload: {kind: 'span', source: 'opentelemetry', name: span.name, spanKind: span.kind,
            traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: flags,
            parentSpanId: span.parentSpanContext?.spanId ?? span.parentSpanId,
            durationMs: Math.max(0, span.duration[0] * 1000 + span.duration[1] / 1e6), failed: span.status.code === 2,
            status: span.status, attributes: span.attributes, events: span.events, scope: span.instrumentationScope,
            ...http,
            ...(this.options.component ? {component: this.options.component} : {}),
            ...(this.options.serviceName || this.options.component ? {service: this.options.serviceName ?? this.options.component} : {}),
          },
        }, this.options);
        if (event) this.events.push(event);
        const exception = span.events.find(item => item.name === 'exception');
        if ((exception || (http && (http.statusCode >= 500 || http.statusCode === 0))) && this.events.length < 1000) {
          const attributes = exception?.attributes ?? {};
          const error = prepareEvent({id: eventId(), ts: Math.floor(span.startTime[0] * 1000 + span.startTime[1] / 1e6), type: 'error',
            environment: this.options.environment ?? 'production', release: this.options.release,
            message: typeof attributes['exception.message'] === 'string' ? attributes['exception.message'] : `HTTP ${http?.statusCode ?? 0}`,
            signal: {version: 1, source: 'server', mechanism: exception ? 'framework_error' : http?.statusCode ? 'http_error' : 'network_error', handled: !exception, level: 'error', ...(http?.statusCode ? {statusCode: http.statusCode} : {})},
            payload: {traceId: ctx.traceId, spanId: ctx.spanId, component: this.options.component, service: this.options.serviceName ?? this.options.component,
              ...(http ? {request: http} : {}), stack: attributes['exception.stacktrace']},
          }, this.options);
          if (error) this.events.push(error);
        }
      }
    } catch { callback({code: 1, error: new Error('Everock could not serialize spans')}); return; }
    void this.flush().then(async success => success && (this.events.length ? await this.flush() : true))
      .then(success => callback(success ? {code: 0} : {code: 1, error: new Error('Everock collector unavailable')}));
  }
  private isCollector(raw: string): boolean {
    try {
      const url = new URL(raw), collector = new URL(this.endpoint);
      return url.origin === collector.origin && (url.pathname === `${collector.pathname.replace(/\/$/, '')}/ingest` || url.pathname.startsWith(`${collector.pathname.replace(/\/$/, '')}/ingest/`));
    } catch { return false; }
  }
  private flush(): Promise<boolean> {
    if (this.pending) return this.pending;
    const events = this.events.splice(0);
    const run = async () => {
      while (events.length) {
        let batch = takeBatch(events, 50, 18 * 1024);
        // One large event still fits with a single bounded service observation.
        if (!batch.length && events.length) batch = takeBatch(events, 1);
        if (!batch.length) continue;
        const services = new Map<string, {host: string; ok: number; fail: number; self: boolean}>();
        for (const event of batch) {
          const payload = event.payload as {kind?: string; direction?: string; host?: string; failed?: boolean} | undefined;
          if (payload?.kind !== 'http' || payload.direction !== 'outbound' || !payload.host) continue;
          const item = services.get(payload.host) ?? {host: payload.host, ok: 0, fail: 0, self: false};
          item[payload.failed ? 'fail' : 'ok']++;
          services.set(payload.host, item);
        }
        const result = await this.sender.send(`${this.endpoint}/ingest`, this.options.publicKey, {events: batch, services: [...services.values()]}, this.options.transport);
        if (!result.delivered) {
          if (result.retry) this.events = [...batch, ...events, ...this.events].slice(-1000);
          return false;
        }
      }
      return true;
    };
    const pending = run().finally(() => {if (this.pending === pending) this.pending = null;});
    this.pending = pending; return pending;
  }
  async forceFlush(): Promise<void> {
    if (!await this.flush()) throw new Error('Everock spans remain undelivered');
    if (this.events.length && !await this.flush()) throw new Error('Everock spans remain undelivered');
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    try { await this.forceFlush(); } finally {this.sender.cancel(); this.events = [];}
  }
}
