export type {EventStore,PersistenceOptions,StoredEvent} from './persistence.js';
import {DurableQueue,type EventStore,type PersistenceOptions} from './persistence.js';
import {browserEventStore} from './persistence-browser.js';
import {eventId} from './ids.js';
import {requestMeasurement} from './request-measurement.js';
import {childSpan, parseTraceparent, tracedRequest, shouldPropagate, traceparent, type TraceContext} from './tracing.js';
import {DeliveryTransport, takeBatch, bytes, type TransportOptions} from './transport.js';
import {prepareEvent, type PrivacyOptions} from './privacy.js';
export type {PrivacyOptions, TelemetryEvent} from './privacy.js';
import { startBrowserPlugins } from './browser-plugins.js';
import type { BrowserSettings } from '@everock/shared/browser-settings';
/**
 * @everock/sdk — the browser SDK an app installs so a surface starts
 * receiving telemetry. It hooks the global error handlers, batches events, and
 * POSTs them to the public ingest endpoint using the surface's public key.
 *
 *   import { init } from '@everock/sdk';
 *   init({ publicKey: 'pk_…', endpoint: 'https://collector.everock.example' });
 */

import { httpMeasurement, isTelemetryRequest, startWebVitals, startRuntimePerformance } from './performance.js';
import type { ReplayController, SessionReplayOptions } from './replay.js';
import type { SignalLevel, SignalMechanism, TelemetrySignal } from '@everock/shared';
export type { SessionReplayOptions } from './replay.js';

export type EventType = 'error' | 'session' | 'trace' | 'log';

export interface ConsentState { analytics: boolean; replay: boolean; }
export interface InitOptions extends PrivacyOptions {
  /** Bounded pending-event journal; false disables disk/IndexedDB storage. */
  persistence?: false | (PersistenceOptions & {directory?:string;store?:EventStore});
  /** Omit to preserve existing capture. Supply false before asking your visitor for consent. */
  consent?: Partial<ConsentState>;
  transport?: TransportOptions;
  /** Origins allowed to receive traceparent in addition to the current origin. */
  tracePropagationTargets?: string[];
  /** Component slug configured inside this project, e.g. web or api. */
  component?: string;
  /** Name shown in the project's event series (e.g. Web app or Public API). */
  serviceName?: string;
  /** Capture fetch durations and status codes, excluding query strings. Default true. */
  captureRequests?: boolean;
  /** Capture LCP, INP and CLS using web-vitals. Default true. */
  capturePerformance?: boolean;
  /** Surface public key (pk_…). Safe to expose in the browser. */
  publicKey: string;
  /** Everock API base URL; the SDK POSTs to `${endpoint}/ingest`. */
  endpoint?: string;
  /** Environment tag applied to every event. */
  environment?: string;
  /** Release slug applied to every event (usually the build's git sha). */
  release?: string;
  /** Set false to disable capture (e.g. in development). Default true. */
  enabled?: boolean;
  /** How often the queue is flushed, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Max events per network request. Default 50. */
  maxBatch?: number;
  /**
   * Fraction (0–1) of NON-error events kept. Errors are always kept 100%.
   * Lower it under heavy traffic to cut volume + overhead. Default 1.
   */
  sampleRate?: number;
  /** Error-triggered DOM session replay. Disabled by default. */
  sessionReplay?: boolean | SessionReplayOptions;
}

/** Where the event came from — detected once at init. */
export interface SdkContext {
  framework?: string; // nextjs | react | vue | nuxt | svelte | angular | remix | react-native
  platform?: string; // web | ios | android | react-native
  browser?: string; // chrome | safari | firefox | edge
  os?: string; // macos | windows | linux | ios | android
  deviceType?: string; // desktop | tablet | mobile
}

interface Envelope {
  id?: string;
  ts: number;
  type: EventType;
  environment?: string;
  release?: string;
  message?: string;
  sessionId?: string;
  userId?: string;
  context?: SdkContext;
  signal?: TelemetrySignal;
  payload?: unknown;
}

export interface CaptureErrorOptions {
  /** True when application code caught and recovered from the error. */
  handled?: boolean;
  mechanism?: Extract<SignalMechanism, 'handled_exception' | 'framework_error' | 'business_failure' | 'manual'>;
  level?: SignalLevel;
  expected?: boolean;
  operation?: string;
  extra?: Record<string, unknown>;
}

let context: SdkContext = {};
let pageSpan: TraceContext | undefined;

/**
 * Best-effort detection of the framework/platform the SDK is running in, using
 * globals each framework leaves on window and the user agent. Heuristic but
 * honest — only reports what it can actually observe.
 */
function detectContext(): SdkContext {
  const ctx: SdkContext = {};
  const g = globalThis as Record<string, unknown>;

  // React Native has no DOM; navigator.product flags it.
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav && (nav as { product?: string }).product === 'ReactNative') {
    ctx.platform = 'react-native';
    ctx.framework = 'react-native';
    return ctx;
  }

  const ua = nav?.userAgent ?? '';
  // platform / os from the user agent
  const ipadOs = /Macintosh/i.test(ua) && (nav?.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || ipadOs) {
    ctx.platform = 'ios';
    ctx.os = 'ios';
    ctx.deviceType = /iPad/i.test(ua) || ipadOs ? 'tablet' : 'mobile';
  } else if (/Android/i.test(ua)) {
    ctx.platform = 'android';
    ctx.os = 'android';
    ctx.deviceType = /Mobile/i.test(ua) ? 'mobile' : 'tablet';
  } else {
    ctx.platform = 'web';
    ctx.deviceType = 'desktop';
    if (/Mac OS X/i.test(ua)) ctx.os = 'macos';
    else if (/Windows/i.test(ua)) ctx.os = 'windows';
    else if (/Linux/i.test(ua)) ctx.os = 'linux';
  }
  // browser
  if (/Edg(?:A|iOS)?\//i.test(ua)) ctx.browser = 'edge';
  else if (/Firefox\/|FxiOS\//i.test(ua)) ctx.browser = 'firefox';
  else if (/Chrome\/|CriOS\//i.test(ua)) ctx.browser = 'chrome';
  else if (/Safari\//i.test(ua)) ctx.browser = 'safari';

  // framework — check the most specific, reliable globals first
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (g.__NEXT_DATA__ || g.next || doc?.getElementById('__next')) ctx.framework = 'nextjs';
  else if (g.__NUXT__ || g.$nuxt) ctx.framework = 'nuxt';
  else if (g.__remixContext) ctx.framework = 'remix';
  else if (Object.keys(g).some((k) => k.startsWith('__sveltekit'))) ctx.framework = 'svelte';
  else if (doc?.querySelector('[ng-version]')) ctx.framework = 'angular';
  else if (g.__VUE__ || doc?.querySelector('[data-v-app]')) ctx.framework = 'vue';
  else if (
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
    doc?.querySelector('[data-reactroot]') ||
    (doc?.getElementById('root') &&
      Object.keys(doc.getElementById('root') as object).some((k) => k.startsWith('__react')))
  )
    ctx.framework = 'react';

  return ctx;
}

interface Config extends PrivacyOptions {
  tracePropagationTargets?: string[];
  transport?: TransportOptions;
  replayAllowed: boolean;
  serviceName?: string;
  component?: string;
  captureRequests: boolean;
  capturePerformance: boolean;
  publicKey: string;
  endpoint: string;
  environment: string;
  release?: string;
  enabled: boolean;
  flushIntervalMs: number;
  maxBatch: number;
  sampleRate: number;
  sessionReplay: Required<SessionReplayOptions>;
}

let cfg: Config | null = null;
let queue: Envelope[] = [];
let delivery = new DeliveryTransport();
let pendingFlush: Promise<void> | null = null;
let durable:DurableQueue|null=null;
let droppedMemory=0,discardedFiltered=0;
const droppedByReason:Record<string,number>={};
const countDrop=(reason:string)=>{droppedByReason[reason]=(droppedByReason[reason]??0)+1;};
let persistenceOptions:InitOptions['persistence'];
let privacyPurge:Promise<void>=Promise.resolve();
function startPersistence(){if(!cfg||!consentState.analytics||persistenceOptions===false)return;const store=persistenceOptions?.store??browserEventStore(`${cfg.endpoint}|${cfg.publicKey}|${cfg.component??'main'}`);const purge=privacyPurge;durable=new DurableQueue({load:async()=>{await purge;return store.load();},apply:(put,remove)=>store.apply(put,remove),clear:()=>store.clear()},persistenceOptions||{});}
let consentState: ConsentState = {analytics: true, replay: true};
let remotePlugins: BrowserSettings['plugins'] = {replay: false, logs: false, pageEvents: false, rageClick: false};
let stopVitals: (() => void) | null = null;
let stopRuntimePerformance: (() => void) | null = null;
export function getConsent(): Readonly<ConsentState> { return {...consentState}; }
/** Visitor consent always takes priority over dashboard settings. Revocation discards unsent data. */
export function setConsent(next: Partial<ConsentState>): void {
  const previous = consentState;
  consentState = {...previous, ...next};
  if (!cfg) return;
  if (!consentState.analytics) {
    ++captureEpoch;
    delivery.cancel(); delivery = new DeliveryTransport(); pendingFlush = null;
    const journal=durable;durable=null;privacyPurge=privacyPurge.then(()=>journal?.clear()).catch(()=>{});
    queue = []; seenServices.clear();
    settingsAbort?.abort();
    stopVitals?.(); stopVitals = null;
    stopRuntimePerformance?.(); stopRuntimePerformance = null;
    sessionId = undefined; deviceId = undefined; userId = undefined; pageSpan = undefined;
  }
  if ((!consentState.replay || !consentState.analytics) && (previous.replay || previous.analytics)) {
    ++replayEpoch; replayController?.stop(true); replayController = null; replayStart = null; pendingReplayErrorAt = null;
  }
  if (consentState.analytics && !previous.analytics) {
    startPersistence();
    sessionId = resolveSessionId(); deviceId = resolveDeviceId(); pageSpan = childSpan();
    enqueue('session', 'Session started');
    startVitals(); void refreshBrowserSettings();
  }
  applyPlugins();
}
function startVitals(): void {
  if (!cfg?.capturePerformance || !consentState.analytics || stopVitals) return;
  const active = cfg;
  stopRuntimePerformance ??= startRuntimePerformance(payload => { if (cfg === active && consentState.analytics) enqueue('trace', payload.name, payload); });
  // Async module loading may finish after consent was revoked.
  void startWebVitals(payload => { if (cfg === active && consentState.analytics && active.capturePerformance) enqueue('trace', payload.name, payload); })
    .then(stop => { if (cfg === active && consentState.analytics) {stopVitals?.(); stopVitals = stop;} else stop(); });
}
function applyPlugins(): void {
  stopBrowserPlugins?.(); stopBrowserPlugins = null;
  if (!cfg) return;
  cfg.sessionReplay.enabled = cfg.replayAllowed && consentState.analytics && consentState.replay && remotePlugins.replay;
  if (consentState.analytics) stopBrowserPlugins = startBrowserPlugins(remotePlugins, (type, message, payload) => enqueue(type, message, payload));
  if (cfg.sessionReplay.enabled) startReplayIfEnabled();
  else { ++replayEpoch; replayController?.stop(true); replayController = null; replayStart = null; pendingReplayErrorAt = null; }
}
let timer: ReturnType<typeof setInterval> | null = null;
let sessionId: string | undefined;
let userId: string | undefined;
let deviceId: string | undefined;
let replayController: ReplayController | null = null;
let replayStart: Promise<void> | null = null;
let pendingReplayErrorAt: number | null = null;
let settingsTimer: ReturnType<typeof setInterval> | null = null;
let stopBrowserPlugins: (() => void) | null = null;
let settingsAbort: AbortController | null = null;
let pluginsSignature = '';
let replayEpoch = 0;
let captureEpoch = 0;
function startReplayIfEnabled() {
  if (!consentState.analytics || !consentState.replay || !cfg?.sessionReplay.enabled || replayController || replayStart || !sessionId) return;
  const activeCfg=cfg, activeSession=sessionId, epoch=++replayEpoch;
  replayStart=import('./replay.js').then(async ({startReplayRecorder})=>{
    if(cfg!==activeCfg || epoch!==replayEpoch || !activeCfg.sessionReplay.enabled)return null;
    return startReplayRecorder({endpoint:activeCfg.endpoint,publicKey:activeCfg.publicKey,sessionId:activeSession,userId:()=>userId,environment:activeCfg.environment,release:activeCfg.release,context,options:activeCfg.sessionReplay, privacy:activeCfg,isAllowed:()=>cfg===activeCfg&&epoch===replayEpoch&&consentState.analytics&&consentState.replay&&activeCfg.sessionReplay.enabled});
  }).then(controller=>{
    if(cfg!==activeCfg || epoch!==replayEpoch || !activeCfg.sessionReplay.enabled){controller?.stop();return;}
    replayController=controller;
    if(controller&&pendingReplayErrorAt!==null)controller.trigger(pendingReplayErrorAt);
    pendingReplayErrorAt=null;
  }).catch(()=>{}).finally(()=>{if(epoch===replayEpoch)replayStart=null;});
}
async function refreshBrowserSettings() {
  if(!cfg || !consentState.analytics || settingsAbort)return;
  const activeCfg=cfg;
  const controller=new AbortController(); settingsAbort=controller;
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(`${activeCfg.endpoint}/sdk/config?key=${encodeURIComponent(activeCfg.publicKey)}`,{signal:controller.signal,cache:'no-store',credentials:'omit'});
    if(!response.ok||cfg!==activeCfg)return;
    const data=await response.json() as {plugins?:BrowserSettings['plugins']};
    const plugins=data.plugins;
    if(!plugins||!['replay','logs','pageEvents','rageClick'].every(key=>typeof plugins[key as keyof typeof plugins]==='boolean'))return;
    const signature=JSON.stringify(plugins);
    if(signature===pluginsSignature)return;
    pluginsSignature=signature; remotePlugins={...plugins}; applyPlugins();
    durable?.discardWhere(event=>{const kind=event.payload?.kind;return kind==='console'&&!plugins.logs||kind==='page_view'&&!plugins.pageEvents||kind==='rage_click'&&!plugins.rageClick;});
    queue=queue.filter(event=>{const kind=(event.payload as {kind?:string})?.kind;return !(kind==='console'&&!plugins.logs||kind==='page_view'&&!plugins.pageEvents||kind==='rage_click'&&!plugins.rageClick);});
  } catch { /* retain the last confirmed configuration while offline */ }
  finally {clearTimeout(timeout);if(settingsAbort===controller)settingsAbort=null;}
}

/** One id per browser session (tab-scoped), so problems can count sessions. */
function resolveSessionId(): string {
  const KEY = 'everock.sid';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const sid = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(KEY, sid);
    return sid;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function resolveDeviceId(): string | undefined {
  try {
    const key = 'everock.device';
    const stored = localStorage.getItem(key);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch { return undefined; }
}

/**
 * Tell the SDK who the current user is (e.g. after login) so problems can
 * report how many real users they impact. Pass null to clear on logout.
 */
export function identify(user: { id: string } | string | null): void {
  if (!consentState.analytics) return;
  userId = user == null ? undefined : typeof user === 'string' ? user : user.id;
}

const DEFAULTS = {
  endpoint: 'https://collector.everock.example',
  environment: 'production',
  enabled: true,
  flushIntervalMs: 5000,
  maxBatch: 50,
  sampleRate: 1,
};

// Hard caps so the SDK can never blow up the app's memory under backpressure.
const MAX_QUEUE = 1000; // events buffered before we drop the oldest
const MAX_SERVICES = 200; // distinct hosts tracked per flush window

// ── auto service discovery ──
// Every host the app talks to (via fetch) becomes a detected "service" whose
// health is inferred from whether those calls succeed. Zero config.
let seenServices = new Map<string, { ok: number; fail: number; self: boolean }>();
let fetchWrapped = false;

function noteHost(host: string, ok: boolean, self: boolean): void {
  if (!cfg?.enabled || !consentState.analytics || !host) return;
  // Bound the map — a runaway app hitting thousands of hosts can't grow it forever.
  if (!seenServices.has(host) && seenServices.size >= MAX_SERVICES) return;
  const s = seenServices.get(host) ?? { ok: 0, fail: 0, self };
  if (ok) s.ok++;
  else s.fail++;
  s.self = s.self || self;
  seenServices.set(host, s);
}

function wrapFetch(): void {
  if (fetchWrapped || typeof window === 'undefined' || !window.fetch) return;
  fetchWrapped = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let host = '';
    let requestUrl = '';
    let internalRequest = false;
    const startedAt = performance.now();
    try {
      const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      requestUrl = raw;
      const request = new URL(raw, location.href);
      host = request.hostname;
      internalRequest = isTelemetryRequest(raw, location.href, cfg?.endpoint ?? DEFAULTS.endpoint);
    } catch {
      /* opaque URL — skip */
    }
    const active = cfg, epoch = captureEpoch;
    const canRecord = () => !!active?.enabled && consentState.analytics && cfg === active && epoch === captureEpoch;
    const permittedAtStart = canRecord();
    const traced = permittedAtStart && !internalRequest ? tracedRequest(input, init, pageSpan, active?.tracePropagationTargets, location.href) : undefined;
    const requestMethod=init?.method??(input instanceof Request?input.method:'GET');
    const requestEvidence=(status:number)=>requestMeasurement(new URL(requestUrl,location.href).href,requestMethod,status,performance.now()-startedAt,{direction:'outbound'});
    const self = host === location.hostname;
    const record = (status: number) => {
      if (!permittedAtStart || !canRecord() || !cfg?.captureRequests || !host || internalRequest) return;
      const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
      const payload = httpMeasurement(requestUrl, location.href, method, status, performance.now() - startedAt);
      if (payload) enqueue('trace', `${payload.method} ${payload.path}`, {...payload,...traced?.span});
    };
    try {
      const res = await orig(input, traced?.init ?? init);
      if (permittedAtStart && canRecord() && !internalRequest) noteHost(host, res.status < 500, self);
      record(res.status);
      if (permittedAtStart && canRecord() && host && !internalRequest && res.status >= 500) {
        enqueue(
          'error',
          `HTTP ${res.status} from ${host}`,
          { host, statusCode: res.status,request:requestEvidence(res.status) },
          {
            version: 1,
            source: 'browser',
            mechanism: 'http_error',
            handled: true,
            level: 'error',
            statusCode: res.status,
            operation: host,
          },
        );
      }
      return res;
    } catch (err) {
      if (permittedAtStart && canRecord() && !internalRequest) noteHost(host, false, self);
      record(0);
      if (permittedAtStart && canRecord() && host && !internalRequest) {
        const value = err as { message?: string } | undefined;
        enqueue(
          'error',
          value?.message ?? `Network request to ${host} failed`,
          { host,request:requestEvidence(0) },
          {
            version: 1,
            source: 'browser',
            mechanism: 'network_error',
            handled: true,
            level: 'error',
            operation: host,
          },
        );
      }
      throw err;
    }
  };
}

let xhrWrapped = false;
function wrapXHR(): void {
  if (xhrWrapped || typeof XMLHttpRequest === 'undefined') return;
  xhrWrapped = true;
  const prototype = XMLHttpRequest.prototype, open = prototype.open, send = prototype.send, setHeader = prototype.setRequestHeader;
  const requests = new WeakMap<XMLHttpRequest, {url: string; method: string; hasTraceparent?: boolean; trace?: TraceContext}>();
  prototype.open = function(...args: unknown[]) {
    requests.set(this, {method: String(args[0]), url: String(args[1])});
    return Reflect.apply(open, this, args);
  };
  prototype.setRequestHeader = function(name: string, value: string) {
    const result = setHeader.call(this, name, value);
    const request = requests.get(this);
    if (request && name.toLowerCase() === 'traceparent') {request.hasTraceparent = true; request.trace = parseTraceparent(value);}
    return result;
  };
  prototype.send = function(...args: Parameters<XMLHttpRequest['send']>) {
    const info = requests.get(this), active = cfg, epoch = captureEpoch;
    if (!info || !active?.enabled || !consentState.analytics || isTelemetryRequest(info.url, location.href, active.endpoint)) return Reflect.apply(send, this, args);
    const span = info.trace ?? childSpan(pageSpan), started = performance.now();
    try { if (!info.hasTraceparent && shouldPropagate(info.url, active.tracePropagationTargets, location.href)) setHeader.call(this, 'traceparent', traceparent(span)); } catch { /* Preserve caller's XHR state/errors. */ }
    const done = () => {
      if (cfg !== active || epoch !== captureEpoch || !consentState.analytics) return;
      try {
        const host = new URL(info.url, location.href).hostname;
        noteHost(host, this.status < 500 && this.status !== 0, host === location.hostname);
        const payload = httpMeasurement(info.url, location.href, info.method, this.status, performance.now() - started);
        if (active.captureRequests && payload) enqueue('trace', `${payload.method} ${payload.path}`, {...payload,...span});
        if (this.status === 0 || this.status >= 500) enqueue('error', this.status ? `HTTP ${this.status} from ${host}` : `Network request to ${host} failed`, {host, statusCode: this.status,request:requestMeasurement(new URL(info.url,location.href).href,info.method,this.status,performance.now()-started,{direction:'outbound'})}, {
          version: 1, source: 'browser', mechanism: this.status ? 'http_error' : 'network_error', handled: true, level: 'error', statusCode: this.status >= 100 ? this.status : undefined, operation: host,
        });
      } catch { /* Never alter application callbacks. */ }
    };
    this.addEventListener('loadend', done, {once: true});
    try { return Reflect.apply(send, this, args); }
    catch (error) { this.removeEventListener('loadend', done); throw error; }
  };
}

/** Drain accumulated per-host tallies for the next flush. */
function drainServices(): { host: string; ok: number; fail: number; self: boolean }[] {
  if (seenServices.size === 0) return [];
  const out = [...seenServices.entries()].map(([host, s]) => ({ host, ...s }));
  seenServices = new Map();
  return out;
}

function replayOptions(value: InitOptions['sessionReplay']): Required<SessionReplayOptions> {
  const options = typeof value === 'object' ? value : {};
  return {
    enabled: value === true || (typeof value === 'object' && value.enabled !== false),
    sampleRate: Math.min(1, Math.max(0, options.sampleRate ?? 1)),
    bufferMs: Math.max(15_000, options.bufferMs ?? 60_000),
    postErrorMs: Math.max(5_000, options.postErrorMs ?? 20_000),
    chunkIntervalMs: Math.max(1_000, options.chunkIntervalMs ?? 3_000),
    maskAllInputs: options.maskAllInputs ?? true,
    maskAllText: options.maskAllText ?? false,
  };
}

/** Start capturing. Safe to call once at app startup; a no-op on the server. */
export function init(opts: InitOptions): void {
  if (typeof window === 'undefined') return; // SSR / non-browser: nothing to hook
  if (cfg) shutdown();
  if (!opts.publicKey) {
    console.warn('[everock] init() called without a publicKey — telemetry disabled');
    return;
  }
  persistenceOptions=opts.persistence;
  ++captureEpoch;
  delivery = new DeliveryTransport(); pendingFlush = null;
  consentState = opts.consent ? {analytics: opts.consent.analytics ?? false, replay: opts.consent.replay ?? false} : {analytics: true, replay: true};
  remotePlugins = {replay: replayOptions(opts.sessionReplay).enabled, logs: false, pageEvents: false, rageClick: false};
  cfg = {
    beforeSend: opts.beforeSend, redactKeys: opts.redactKeys, transport: opts.transport, tracePropagationTargets: opts.tracePropagationTargets,
    replayAllowed: opts.sessionReplay !== false && !(typeof opts.sessionReplay === 'object' && opts.sessionReplay.enabled === false),
    serviceName: opts.serviceName?.slice(0, 80),
    component: opts.component,
    captureRequests: opts.captureRequests ?? true,
    capturePerformance: opts.capturePerformance ?? true,
    publicKey: opts.publicKey,
    endpoint: (opts.endpoint ?? DEFAULTS.endpoint).replace(/\/$/, ''),
    environment: opts.environment ?? DEFAULTS.environment,
    release: opts.release,
    enabled: opts.enabled ?? DEFAULTS.enabled,
    flushIntervalMs: opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxBatch: Math.max(1, Math.min(100, opts.maxBatch ?? DEFAULTS.maxBatch)),
    sampleRate: Math.min(1, Math.max(0, opts.sampleRate ?? DEFAULTS.sampleRate)),
    sessionReplay: replayOptions(opts.sessionReplay),
  };
  if (!cfg.enabled) return;
  context = detectContext();
  wrapFetch(); wrapXHR();
  if (consentState.analytics) {
    startPersistence();
    sessionId = resolveSessionId(); deviceId = resolveDeviceId(); pageSpan = childSpan();
    startVitals(); enqueue('session', 'Session started');
    void refreshBrowserSettings();
  }
  applyPlugins();
  settingsTimer = setInterval(() => void refreshBrowserSettings(), 30000);

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  timer = setInterval(() => void flush(), cfg.flushIntervalMs);
}

/** Manually record an event (e.g. a custom breadcrumb or trace). */
export function capture(
  type: EventType,
  message?: string,
  payload?: unknown,
): void {
  const signal: TelemetrySignal | undefined =
    type === 'error'
      ? {
          version: 1,
          source: 'custom',
          mechanism: 'manual',
          handled: true,
          level: 'error',
        }
      : undefined;
  enqueue(type, message, payload, signal);
}

function enqueue(
  type: EventType,
  message?: string,
  payload?: unknown,
  signal?: TelemetrySignal,
): void {
  if (!cfg?.enabled || !consentState.analytics) return;
  // Keep every error; sample the high-volume, low-value rest.
  if (type !== 'error' && cfg.sampleRate < 1 && Math.random() >= cfg.sampleRate) {countDrop('sampled');return;}
  if (type === 'error') triggerReplay();
  // Bounded buffer: under backpressure (network down) drop the oldest, never OOM.
  const safe = prepareEvent({
    id: eventId(),
    ts: Date.now(),
    type,
    environment: cfg.environment,
    release: cfg.release,
    message,
    sessionId,
    userId,
    context,
    signal,
    payload: {
      ...pageSpan,
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : payload == null ? {} : { value: payload }),
      ...(deviceId ? { deviceId } : {}),
      ...(cfg.serviceName || cfg.component ? { service: cfg.serviceName ?? cfg.component } : {}),
      ...(cfg.component ? { component: cfg.component } : {}),
    },
  }, cfg,countDrop);
  if (safe) {
    if (queue.length >= MAX_QUEUE) {queue.shift();droppedMemory++;}
    queue.push(safe);
    durable?.put(safe);
  } else discardedFiltered++;
  if (queue.length >= cfg.maxBatch) void flush();
}

/** Record a caught or framework-reported browser failure with explicit semantics. */
export function captureError(error: unknown, options: CaptureErrorOptions = {}): void {
  const value = error as { message?: string; stack?: string } | undefined;
  const handled = options.handled ?? true;
  enqueue(
    'error',
    value?.message ?? String(error),
    { stack: value?.stack, ...options.extra },
    {
      version: 1,
      source: 'browser',
      mechanism: options.mechanism ?? (handled ? 'handled_exception' : 'framework_error'),
      handled,
      level: options.level ?? 'error',
      expected: options.expected,
      operation: options.operation,
    },
  );
}

function onError(e: ErrorEvent): void {
  enqueue(
    'error',
    e.message,
    {
      stack: e.error?.stack,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      url: location.href,
    },
    {
      version: 1,
      source: 'browser',
      mechanism: 'unhandled_exception',
      handled: false,
      level: 'error',
    },
  );
}

function onRejection(e: PromiseRejectionEvent): void {
  const reason = e.reason;
  enqueue(
    'error',
    reason?.message ?? String(reason),
    {
      stack: reason?.stack,
      url: location.href,
      unhandledRejection: true,
    },
    {
      version: 1,
      source: 'browser',
      mechanism: 'unhandled_rejection',
      handled: false,
      level: 'error',
    },
  );
}

function triggerReplay(): void {
  const now = Date.now();
  if (replayController) replayController.trigger(now);
  else if (replayStart) pendingReplayErrorAt = pendingReplayErrorAt ?? now;
}

/** Send whatever is queued. `beacon` uses sendBeacon so it survives unload. */
export function flush(beacon = false): Promise<void> {
  if (pendingFlush) return pendingFlush;
  if (!cfg?.enabled || !consentState.analytics) return Promise.resolve();
  const active = cfg, sender = delivery;
  const journal=durable;
  const events = queue.splice(0), services = drainServices();
  const run = async () => {
    if(journal){await journal.ready;const recovered=journal.recover();const expired=journal.drainExpired();for(let i=events.length-1;i>=0;i--)if(expired.has(events[i]!.id!))events.splice(i,1);const ids=new Set([...events,...queue].map(event=>event.id));for(const event of recovered)if(!ids.has(event.id)){events.push(event);ids.add(event.id);}await journal.sync();}
    if(sender!==delivery)return;
    let observed = services;
    while (events.length || observed.length) {
      const current = observed.splice(0, 50);
      const batch = takeBatch(events, active.maxBatch, bytes(JSON.stringify(current)) + 128);
      const result = await sender.send(`${active.endpoint}/ingest`, active.publicKey, {events: batch, services: current}, active.transport, beacon);
      if(!result.retry && (!beacon || !result.delivered))journal?.ack(batch,!result.delivered);
      if (result.retry) {
        if (cfg === active && sender === delivery && consentState.analytics) {
          queue.unshift(...batch, ...events); queue = queue.slice(-MAX_QUEUE);
          for (const service of [...current, ...observed]) {
            const prior = seenServices.get(service.host);
            if (!prior && seenServices.size >= MAX_SERVICES) continue;
            seenServices.set(service.host, {ok: service.ok + (prior?.ok ?? 0), fail: service.fail + (prior?.fail ?? 0), self: service.self || prior?.self || false});
          }
        }
        break;
      }
    }
    await journal?.sync();
  };
  const pending = run().finally(() => { if (pendingFlush === pending) pendingFlush = null; });
  pendingFlush = pending;
  return pending;
}

function onPageHide() { flush(true); }
function onVisibilityChange() { if (document.visibilityState === 'hidden') flush(true); }

/** Stop capturing and flush anything pending (mostly for tests/HMR). */
export function shutdown(): Promise<void> {
  const sender = delivery;
  ++replayEpoch;
  if(settingsTimer)clearInterval(settingsTimer);
  settingsTimer=null;settingsAbort?.abort();settingsAbort=null;
  stopBrowserPlugins?.();stopBrowserPlugins=null;pluginsSignature='';
  stopVitals?.(); stopVitals = null;
    stopRuntimePerformance?.(); stopRuntimePerformance = null;
  if (timer) clearInterval(timer);
  timer = null;
  replayController?.stop();
  replayController = null;
  replayStart = null;
  pendingReplayErrorAt = null;
  const completion = flush(true);
  if (typeof window !== 'undefined') {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  cfg = null;
  queue = [];
  sessionId = undefined;
  pageSpan = undefined;
  userId = undefined;
  context = {};
  seenServices = new Map();
  return completion.finally(() => sender.cancel());
}

/** Local diagnostics; contains no event contents, keys or collector URL. */
export function getDiagnostics(){return {...delivery.getDiagnostics(),queuedEvents:queue.length,inFlight:!!pendingFlush,droppedByReason:{...droppedByReason},droppedMemory,discardedFiltered,persistence:durable?.getDiagnostics()??null};}
