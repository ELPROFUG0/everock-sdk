/** Shared bounded delivery for browser, Node and Workers. No application data is persisted. */
export interface TransportOptions {
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryBudgetMs?: number;
}
export interface DeliveryResult { delivered: boolean; retry: boolean; retryAt: number; }
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Math.min(86_400_000, Math.max(0, delay || 0));
}
export const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export const MAX_BATCH_BYTES = 48_000;
/** A single oversize event is discarded rather than blocking every subsequent batch. */
export function takeBatch<T>(queue: T[], maxEvents = 50, overhead = 1024): T[] {
  maxEvents = Number.isFinite(maxEvents) ? Math.max(1, Math.min(100, maxEvents)) : 50;
  const batch: T[] = []; let size = Math.max(1024, overhead);
  while (queue.length && batch.length < maxEvents) {
    const value = queue[0]!;
    let length: number;
    try { length = bytes(JSON.stringify(value)) + 1; } catch { queue.shift(); continue; }
    if (length > MAX_BATCH_BYTES - 1024) { queue.shift(); continue; }
    if (size + length > MAX_BATCH_BYTES) break;
    batch.push(queue.shift()!); size += length;
  }
  return batch;
}
export class DeliveryTransport {
  private controller = new AbortController();
  private retryAt = 0;
  private disabled = false;
  private diagnostics={attempts:0,deliveredBatches:0,failedRequests:0,lastStatus:null as number|null,lastSuccessAt:null as number|null,lastFailureAt:null as number|null};
  getDiagnostics(){return {...this.diagnostics,retryAt:this.retryAt||null,disabled:this.disabled,stopped:this.controller.signal.aborted};}
  cancel(): void { this.controller.abort(); }
  async send(url: string, publicKey: string, body: unknown, options: TransportOptions = {}, beacon = false): Promise<DeliveryResult> {
    const signal = this.controller.signal;
    if (signal.aborted || this.disabled) return {delivered: false, retry: false, retryAt: 0};
    if (Date.now() < this.retryAt) return {delivered: false, retry: true, retryAt: this.retryAt};
    let serialized: string;
    try { serialized = JSON.stringify(body); } catch { return {delivered: false, retry: false, retryAt: 0}; }
    const browserNavigator = (globalThis as unknown as {navigator?: {sendBeacon?: (url: string, body: Blob) => boolean}}).navigator;
    if (beacon && browserNavigator?.sendBeacon) {
      const beaconBody = JSON.stringify({...body as object, key: publicKey});
      if (bytes(beaconBody) <= MAX_BATCH_BYTES) {
        try { if (browserNavigator.sendBeacon(url, new Blob([beaconBody], {type: 'application/json'}))) return {delivered: true, retry: false, retryAt: 0}; } catch { /* Fall back to fetch. */ }
      }
    }
    const deadline = Date.now() + Math.max(1, options.retryBudgetMs ?? 10_000);
    const attempts = Math.min(5, Math.max(1, options.maxAttempts ?? 3));
    for (let attempt = 0; attempt < attempts && !signal.aborted; attempt++) {
      let delay = 0;
      const request = new AbortController();
      const abort = () => request.abort(); signal.addEventListener('abort', abort, {once: true});
      const timeout = setTimeout(abort, Math.max(1, Math.min(options.requestTimeoutMs ?? 5000, deadline - Date.now())));
      try {
        this.diagnostics.attempts++;
        const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'x-everock-key': publicKey}, body: serialized, signal: request.signal, keepalive: bytes(serialized) <= MAX_BATCH_BYTES, credentials: 'omit'});
        this.diagnostics.lastStatus=response.status;
        if (response.ok) {this.diagnostics.deliveredBatches++;this.diagnostics.lastSuccessAt=Date.now(); void response.body?.cancel().catch(() => {}); this.retryAt = 0; return {delivered: true, retry: false, retryAt: 0}; }
        this.diagnostics.failedRequests++;this.diagnostics.lastFailureAt=Date.now();
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        delay = retryAfter(response.headers.get('retry-after'));
        void response.body?.cancel().catch(() => {});
        if ([401, 403, 404, 410].includes(response.status)) this.disabled = true;
        if (!retryable) return {delivered: false, retry: false, retryAt: 0};
      } catch { this.diagnostics.failedRequests++;this.diagnostics.lastFailureAt=Date.now();this.diagnostics.lastStatus=null; if (signal.aborted || this.disabled) return {delivered: false, retry: false, retryAt: 0}; }
      finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
      delay = Math.max(delay, (options.retryBaseMs ?? 250) * 2 ** attempt + Math.floor(Math.random() * 100));
      this.retryAt = Date.now() + delay;
      if (attempt + 1 >= attempts || this.retryAt >= deadline) return {delivered: false, retry: true, retryAt: this.retryAt};
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay); signal.addEventListener('abort', finish, {once: true});
      });
    }
    return {delivered: false, retry: false, retryAt: 0};
  }
}
