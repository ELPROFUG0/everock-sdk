import {requestMeasurement} from './request-measurement.js';
import type { Metric } from 'web-vitals';

export interface HttpMeasurement {
  kind: 'http'; direction?: 'outbound'; host: string; path: string; method: string; statusCode: number; failed: boolean; durationMs: number;
}
/** Keep endpoint identity, never query parameters, credentials or fragments. */
export function httpMeasurement(raw: string, base: string, method: string, statusCode: number, durationMs: number): HttpMeasurement | null {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { kind: 'http', direction:'outbound', host: url.host, path: requestMeasurement(url.href,method,statusCode,durationMs,{direction:'outbound'})!.path, method: method.toUpperCase().slice(0, 12), statusCode, failed: statusCode === 0 || statusCode >= 400, durationMs: Math.max(0, Math.min(3_600_000, Math.round(durationMs * 100) / 100)) };
  } catch { return null; }
}

export {isTelemetryRequest} from './request-measurement.js';

type Vital = { kind: 'web_vital'; name: string; value: number; id: string };
const subscribers = new Set<(payload: Vital) => void>();
let started = false;
export async function startWebVitals(report: (payload: { kind: 'web_vital'; name: string; value: number; id: string }) => void): Promise<() => void> {
  const stop = () => { subscribers.delete(report); };
  if (typeof PerformanceObserver === 'undefined') return stop;
  subscribers.add(report);
  if (started) return stop;
  started = true;
  try {
    const { onCLS, onINP, onLCP } = await import('web-vitals');
    const onMetric = ({ name, value, id }: Metric) => {
      if (Number.isFinite(value) && value >= 0) subscribers.forEach(callback => callback({ kind: 'web_vital', name, value, id }));
    };
    onCLS(onMetric, { reportAllChanges: true });
    onINP(onMetric, { reportAllChanges: true });
    onLCP(onMetric, { reportAllChanges: true });
  } catch { started = false; subscribers.delete(report); }
  return stop;
}

export interface RuntimePerformanceMeasurement {
  kind: 'long_task' | 'document_load';
  name: string;
  durationMs: number;
  startTime?: number;
  ttfbMs?: number;
}
/** Navigation timings and main-thread stalls, without resource URLs or DOM contents. */
export function startRuntimePerformance(report: (event: RuntimePerformanceMeasurement) => void): () => void {
  let active = true;
  let observer: PerformanceObserver | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finite = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(3_600_000, value)) : 0;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver(list => {
        if (!active) return;
        for (const entry of list.getEntries().slice(-100)) report({kind: 'long_task', name: 'Long task', durationMs: finite(entry.duration), startTime: finite(entry.startTime)});
      });
      // Buffered entries precede consent/start; deliberately observe new tasks only.
      observer.observe({type: 'longtask', buffered: false});
    } catch { observer?.disconnect(); observer = undefined; }
  }
  const loaded = () => {
    if (!active) return;
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation) report({kind: 'document_load', name: 'Document load', durationMs: finite(navigation.duration || navigation.loadEventEnd || performance.now()), ttfbMs: finite(navigation.responseStart - navigation.requestStart)});
  };
  if (typeof window !== 'undefined') {
    if (document.readyState === 'complete') timeout = setTimeout(loaded, 0);
    else window.addEventListener('load', loaded, {once: true});
  }
  return () => { active = false; observer?.disconnect(); if (timeout) clearTimeout(timeout); if (typeof window !== 'undefined') window.removeEventListener('load', loaded); };
}
