export type {EventStore,PersistenceOptions,StoredEvent} from './persistence.js';
import {DurableQueue,type EventStore,type PersistenceOptions} from './persistence.js';
import {nodeEventStore} from './persistence-node.js';
import {eventId} from './ids.js';
import {childSpan, parseTraceparent, traceparent, tracedRequest, shouldPropagate, type TraceContext} from './tracing.js';
import {DeliveryTransport, takeBatch, bytes, type TransportOptions} from './transport.js';
import {prepareEvent, type PrivacyOptions} from './privacy.js';
export type {PrivacyOptions, TelemetryEvent} from './privacy.js';
import {isTelemetryRequest, requestMeasurement} from './request-measurement.js';
/**
 * @everock/sdk/node — the SERVER SDK.
 *
 * Most production problems happen on the backend, not the browser. Install this
 * in your Node service and it:
 *   - captures uncaught errors + unhandled rejections (and lets you capture any),
 *   - auto-detects every outbound service your backend calls (RapidAPI, other
 *     APIs, third parties) by wrapping fetch + http/https, inferring health from
 *     whether those calls succeed,
 * and ships it all to the same surface as the browser SDK.
 *
 *   import { init } from '@everock/sdk/node';
 *   init({ publicKey: 'pk_…', endpoint: 'https://collector.everock.example' });
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import { errorMonitor } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { SignalLevel, SignalMechanism, TelemetrySignal } from '@everock/shared';

export interface NodeInitOptions extends PrivacyOptions {
  /** Bounded pending-event journal; false disables disk/IndexedDB storage. */
  persistence?: false | (PersistenceOptions & {directory?:string;store?:EventStore});
  transport?: TransportOptions;
  tracePropagationTargets?: string[];
  component?: string;
  serviceName?: string;
  publicKey: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  enabled?: boolean;
  flushIntervalMs?: number;
  /** Fraction (0–1) of NON-error events kept. Errors are always kept. Default 1. */
  sampleRate?: number;
  /** Observe incoming Node HTTP requests. Default true. */
  captureRequests?: boolean;
  requestTimeoutMs?: number;
}

interface Envelope {
  id?: string;
  ts: number;
  type: 'error' | 'log' | 'trace';
  environment?: string;
  release?: string;
  message?: string;
  context?: Record<string, string>;
  signal?: TelemetrySignal;
  payload?: unknown;
}

export interface NodeCaptureErrorOptions {
  handled?: boolean;
  mechanism?: SignalMechanism;
  level?: SignalLevel;
  expected?: boolean;
  operation?: string;
  statusCode?: number;
}

interface Config extends Required<Omit<NodeInitOptions, 'release' | 'component' | 'serviceName' | 'beforeSend' | 'redactKeys' | 'transport' | 'tracePropagationTargets' | 'persistence'>> {
  release?: string;
  component?: string;
  serviceName?: string;
  beforeSend?: PrivacyOptions['beforeSend'];
  redactKeys?: string[];
  transport?: TransportOptions;
  tracePropagationTargets?: string[];
}

let cfg: Config | null = null;
let queue: Envelope[] = [];
let delivery = new DeliveryTransport();
let pendingFlush: Promise<void> | null = null;
let durable:DurableQueue|null=null;
let droppedMemory=0,discardedFiltered=0;
const droppedByReason:Record<string,number>={};
const countDrop=(reason:string)=>{droppedByReason[reason]=(droppedByReason[reason]??0)+1;};
let seenServices = new Map<string, { ok: number; fail: number; self: boolean; kind?: string }>();

let timer: ReturnType<typeof setInterval> | null = null;
let wrapped = false;
let dbInstrumented = false;
let inboundWrapped=false;
const requestContext=new AsyncLocalStorage<{recorded:boolean; errorCaptured?:boolean; span?: TraceContext}>();
const incomingMeasurements=new WeakMap<object,{route?:string;errorCaptured?:boolean}>();
function observeRequest(req:http.IncomingMessage,res:http.ServerResponse,route?:string,context=requestContext.getStore()){
 const prior=incomingMeasurements.get(req);if(prior){if(route)prior.route=route;return;}
 if(!cfg?.enabled||!cfg.captureRequests)return;
 try{const target=new URL(cfg.endpoint);if(req.headers.host===target.host&&(req.url??'').split('?')[0]===`${target.pathname.replace(/\/$/,'')}/ingest`)return;}catch{/* Invalid collector configuration is handled by init. */}
 const identity:{route?:string;errorCaptured?:boolean}={route};incomingMeasurements.set(req,identity);
 const started=performance.now();let done=false;
 const record=(status:number,outcome='response')=>{
  if(done)return;done=true;clearTimeout(timeout);res.removeListener('finish',finish);res.removeListener('close',close);
  const request=req as http.IncomingMessage&{route?:{path?:string};baseUrl?:string};
  const template=identity.route??(typeof request.route?.path==='string'?`${request.baseUrl??''}${request.route.path}`:undefined);
  const measurement=requestMeasurement(req.url??'/',req.method??'GET',status,performance.now()-started,{route:template,host:req.headers.host??'runtime',direction:'inbound'});
  if(measurement&&!context?.recorded){if(context)context.recorded=true;capture('trace',undefined,{...measurement,outcome,...context?.span});if(!identity.errorCaptured&&!context?.errorCaptured&&(status>=500||outcome==='timeout'))captureError(new Error(`${outcome==='timeout'?'Request timeout':`HTTP ${status}`} for ${measurement.method} ${measurement.path}`),{request:measurement,path:measurement.path,method:measurement.method,direction:'inbound'},{handled:true,mechanism:outcome==='timeout'?'timeout':'http_error',statusCode:status>=100?status:undefined,operation:measurement.path});}
 };
 const finish=()=>record(res.statusCode),close=()=>record(res.writableFinished?res.statusCode:0,res.writableFinished?'response':'client_abort');
 const timeout=setTimeout(()=>record(0,'timeout'),cfg.requestTimeoutMs);timeout.unref();
 res.once('finish',finish);res.once('close',close);
}
function wrapInbound(){
 if(inboundWrapped)return;inboundWrapped=true;
 for(const prototype of [http.Server.prototype,https.Server.prototype]){
  const emit=prototype.emit;
  prototype.emit=function(event:string,...args:unknown[]){
   if(event==='request'&&args[0]&&args[1])return requestContext.run({recorded:false, span:childSpan(parseTraceparent((args[0] as http.IncomingMessage).headers.traceparent as string | undefined))},()=>{
    try{observeRequest(args[0] as http.IncomingMessage,args[1] as http.ServerResponse);}catch{/* Preserve application behavior. */}
    return Reflect.apply(emit,this,[event,...args]);
   });
   return Reflect.apply(emit,this,[event,...args]);
  };
 }
}
/** Optional Express/Nest middleware; route templates are resolved after response completion. */
export function requestHandler(options:{route?:string}={}){
 return(req:http.IncomingMessage,res:http.ServerResponse,next:(error?:unknown)=>void)=>{observeRequest(req,res,options.route);next();};
}
/** Fetch-style handler for Next.js route handlers and other Node Fetch runtimes. */
export function withRequest<A extends unknown[]>(handler:(request:Request,...args:A)=>Response|Promise<Response>,options:{route?:string}={}){
 return async(request:Request,...args:A)=>{
  const prior = requestContext.getStore();
  const ctx = prior ?? {recorded: false, span: childSpan(parseTraceparent(request.headers.get('traceparent')))};
  return requestContext.run(ctx, async () => {
    const started = performance.now(); let status = 0;
    try { const response = await handler(request, ...args); status = response.status; if(status >= 500 && !ctx.errorCaptured) {ctx.errorCaptured = true; captureError(new Error(`HTTP ${status}`), {request:requestMeasurement(request.url,request.method,status,performance.now()-started,{route:options.route})}, {handled: true, mechanism: 'http_error', statusCode: status});} return response; }
    catch(error) { if(!ctx.errorCaptured){ctx.errorCaptured=true;captureError(error, {request:requestMeasurement(request.url,request.method,status,performance.now()-started,{route:options.route})}, {handled: false, mechanism: 'framework_error'});} throw error; }
    finally { const value = requestMeasurement(request.url, request.method, status, performance.now() - started, {route: options.route}); if(value && !ctx.recorded) {ctx.recorded = true; capture('trace', undefined, value);} }
  });
 };
}
/** AsyncLocalStorage keeps concurrent operations isolated, including after await. */
export function withSpan<T>(name: string, operation: () => T): T {
  if (!cfg?.enabled) return operation();
  const span = childSpan(requestContext.getStore()?.span), started = performance.now();
  return requestContext.run({recorded: false, span}, () => {
    const finish = (error?: unknown) => { capture('trace', name, {kind: 'span', name, durationMs: performance.now() - started, failed: error !== undefined, ...span}); };
    try {
      const result = operation();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') return Promise.resolve(result).then(value => {finish(); return value;}, error => {finish(error); throw error;}) as T;
      finish(); return result;
    } catch (error) {finish(error); throw error;}
  });
}



const DEFAULTS = {
  endpoint: 'https://collector.everock.example',
  environment: 'production',
  enabled: true,
  flushIntervalMs: 5000,
  sampleRate: 1,
};

// Hard caps so the SDK can never grow the app's memory under backpressure.
const MAX_QUEUE = 1000;
const MAX_SERVICES = 200;

function serverContext(): Record<string, string> {
  return { platform: 'server', os: process.platform, runtime: `node-${process.versions.node}` };
}

function noteHost(host: string, ok: boolean, kind?: string): void {
  if (!host || host.length > 253) return;
  if (!seenServices.has(host) && seenServices.size >= MAX_SERVICES) return;
  const s = seenServices.get(host) ?? { ok: 0, fail: 0, self: false, kind };
  if (ok) s.ok++;
  else s.fail++;
  if (kind) s.kind = kind;
  seenServices.set(host, s);
  if (!ok && kind && ['database','webhook','mcp','other'].includes(kind)) captureError(new Error(`Dependency failure: ${host}`), {host,dependencyKind:kind}, {handled:true,mechanism:'dependency_failure',operation:host});
}

function hostOf(input: unknown): string {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    const o = input as { hostname?: string; host?: string };
    return (o.hostname ?? o.host ?? '').replace(/:\d+$/, '');
  } catch {
    return '';
  }
}

function recordOutbound(url:string,method:string,status:number,started:number,span?:TraceContext){
 if(!cfg?.enabled)return;
 const value=requestMeasurement(url,method,status,performance.now()-started,{direction:'outbound'});
 if(value)capture('trace',undefined,{...value,...span});
}

/** Patch fetch + http/https so every outbound call becomes a detected service. */
function wrapOutbound(): void {
  if (wrapped) return;
  wrapped = true;

  const g = globalThis as { fetch?: typeof fetch };
  if (typeof g.fetch === 'function') {
    const orig = g.fetch.bind(globalThis);
    // Derive arg types from the ambient fetch so this file needs no DOM lib
    // (it's the server SDK — consumers may typecheck it under node-only types).
    g.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw=input instanceof Request?input.url:String(input),started=performance.now();
      const method=init?.method??(input instanceof Request?input.method:'GET');
      const host = hostOf(input instanceof Request ? input.url : input);
      if (!cfg?.enabled || isTelemetryRequest(raw, cfg.endpoint, cfg.endpoint)) return orig(input, init);
      const traced = tracedRequest(input, init, requestContext.getStore()?.span, cfg.tracePropagationTargets);
      try {
        const res = await orig(input, traced?.init ?? init);
        noteHost(host, res.status < 500);
        recordOutbound(raw,method,res.status,started,traced?.span);
        if (host && res.status >= 500) {
          captureError(
            new Error(`HTTP ${res.status} from ${host}`),
            { host, statusCode: res.status,request:requestMeasurement(raw,method,res.status,performance.now()-started,{direction:'outbound'}) },
            { handled: true, mechanism: 'http_error', statusCode: res.status, operation: host },
          );
        }
        return res;
      } catch (err) {
        noteHost(host, false);
        recordOutbound(raw,method,0,started,traced?.span);
        if (host) {
          captureError(
            err,
            { host,request:requestMeasurement(raw,method,0,performance.now()-started,{direction:'outbound'}) },
            { handled: true, mechanism: 'network_error', operation: host },
          );
        }
        throw err;
      }
    };
  }

  for (const mod of [http, https]) {
    const orig = mod.request;
    mod.request = function patched(this: unknown, ...args: unknown[]) {
      const host = hostOf(args[0]),started=performance.now();
      // @ts-expect-error — forward all overloads verbatim
      const req = orig.apply(this, args) as http.ClientRequest;
      const raw = `${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`;
      if (!cfg?.enabled || isTelemetryRequest(raw, cfg.endpoint, cfg.endpoint)) return req;
      let span: TraceContext | undefined;
      if (cfg?.enabled) {
        const existing = req.getHeader('traceparent');
        span = parseTraceparent(typeof existing === 'string' ? existing : undefined) ?? childSpan(requestContext.getStore()?.span);
        if (!existing && shouldPropagate(`${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`, cfg.tracePropagationTargets)) req.setHeader('traceparent', traceparent(span));
      }
      req.on('response' , (res: http.IncomingMessage) => {
        const statusCode = res.statusCode ?? 500;
        recordOutbound(`${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`,req.method,statusCode,started,span);
        noteHost(host, statusCode < 500);
        if (host && statusCode >= 500) {
          captureError(
            new Error(`HTTP ${statusCode} from ${host}`),
            { host, statusCode,request:requestMeasurement(`${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`,req.method,statusCode,performance.now()-started,{direction:'outbound'}) },
            { handled: true, mechanism: 'http_error', statusCode, operation: host },
          );
        }
      });
      req.on(errorMonitor, (error: Error) => {
        recordOutbound(`${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`,req.method,0,started,span);
        noteHost(host, false);
        if (host) {
          captureError(error, { host,request:requestMeasurement(`${mod===https?'https':'http'}://${req.getHeader('host')??host}${req.path}`,req.method,0,performance.now()-started,{direction:'outbound'}) }, { handled: true, mechanism: 'network_error', operation: host });
        }
      });
      return req;
    };
  }
}

// Resolve modules from the app's node_modules, not the SDK's.
function appRequire(): NodeRequire {
  try {
    return createRequire(join(process.cwd(), 'index.js'));
  } catch {
    return createRequire(import.meta.url);
  }
}
function tryModule(req: NodeRequire, name: string): unknown {
  try {
    return req(name);
  } catch {
    return null;
  }
}
// Record a call whether the driver returns a promise or throws synchronously.
function settle<T>(r: T, ok: () => void, fail: () => void): T {
  const p = r as { then?: (a: unknown, b: unknown) => unknown };
  if (p && typeof p.then === 'function') {
    return (p.then as (a: unknown, b: unknown) => T).call(
      p,
      (v: unknown) => {
        ok();
        return v;
      },
      (e: unknown) => {
        fail();
        throw e;
      },
    );
  }
  ok();
  return r;
}

/**
 * Patch common DB/cache drivers so TCP services (Postgres, Redis) are detected
 * too — not just HTTP. Health = whether queries succeed. No-op if not installed.
 * Patching the driver covers ORMs built on it (Prisma, Drizzle, Knex, TypeORM).
 */
function instrumentDatabases(): void {
  if (dbInstrumented) return;
  dbInstrumented = true;
  const req = appRequire();

  const pg = tryModule(req, 'pg') as { Client?: { prototype?: Record<string, unknown> } } | null;
  const pgProto = pg?.Client?.prototype;
  if (pgProto && typeof pgProto.query === 'function') {
    const orig = pgProto.query as (...a: unknown[]) => unknown;
    pgProto.query = function (
      this: { host?: string; connectionParameters?: { host?: string } },
      ...args: unknown[]
    ) {
      const host = this.host || this.connectionParameters?.host || 'postgres';
      try {
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          args[args.length - 1] = function (this: unknown, error: unknown, ...result: unknown[]) {
            noteHost(host, !error, 'database');
            return callback.call(this, error, ...result);
          };
          return orig.apply(this, args);
        }
        return settle(
          orig.apply(this, args),
          () => noteHost(host, true, 'database'),
          () => noteHost(host, false, 'database'),
        );
      } catch (e) {
        noteHost(host, false, 'database');
        throw e;
      }
    };
  }

  const ioredis = tryModule(req, 'ioredis') as { default?: unknown } | null;
  const RedisCtor = (ioredis as { default?: unknown })?.default ?? ioredis;
  const redisProto = (RedisCtor as { prototype?: Record<string, unknown> })?.prototype;
  if (redisProto && typeof redisProto.sendCommand === 'function') {
    const orig = redisProto.sendCommand as (...a: unknown[]) => unknown;
    redisProto.sendCommand = function (this: { options?: { host?: string } }, ...args: unknown[]) {
      const host = this.options?.host || 'redis';
      try {
        return settle(
          orig.apply(this, args),
          () => noteHost(host, true, 'database'),
          () => noteHost(host, false, 'database'),
        );
      } catch (e) {
        noteHost(host, false, 'database');
        throw e;
      }
    };
  }

  // mysql2 — Connection.query/execute (callback or promise). Patching the base
  // connection covers mysql2/promise too, which calls it with a callback.
  const mysql = tryModule(req, 'mysql2') as { Connection?: { prototype?: Record<string, unknown> } } | null;
  const myProto = mysql?.Connection?.prototype;
  if (myProto) {
    for (const method of ['query', 'execute'] as const) {
      if (typeof myProto[method] !== 'function') continue;
      const orig = myProto[method] as (...a: unknown[]) => unknown;
      myProto[method] = function (this: { config?: { host?: string } }, ...args: unknown[]) {
        const host = this.config?.host || 'mysql';
        const last = args[args.length - 1];
        if (typeof last === 'function') {
          const cb = last as (err: unknown, ...rest: unknown[]) => unknown;
          args[args.length - 1] = function (this: unknown, err: unknown, ...rest: unknown[]) {
            noteHost(host, !err, 'database');
            return cb.call(this, err, ...rest);
          };
          return orig.apply(this, args);
        }
        try {
          return settle(
            orig.apply(this, args),
            () => noteHost(host, true, 'database'),
            () => noteHost(host, false, 'database'),
          );
        } catch (e) {
          noteHost(host, false, 'database');
          throw e;
        }
      };
    }
  }
}

/** Manually record an error (e.g. inside a caught block or error middleware). */
function enqueue(e: Envelope): void {
  const safe = prepareEvent({...e,id:e.id??eventId(),payload:{...requestContext.getStore()?.span,...(e.payload && typeof e.payload==='object' && !Array.isArray(e.payload)?e.payload:{}),...(cfg?.component?{component:cfg.component}:{}),...(cfg?.serviceName || cfg?.component ? {service:cfg.serviceName??cfg.component}: {})}}, cfg ?? {},countDrop);
  if (safe) {
    if (queue.length >= MAX_QUEUE) {queue.shift();droppedMemory++;}
    queue.push(safe);
    durable?.put(safe);
  } else discardedFiltered++;
}

export function captureError(
  err: unknown,
  extra?: Record<string, unknown>,
  options: NodeCaptureErrorOptions = {},
): void {
  if (!cfg?.enabled) return; // errors are always kept — never sampled
  const e = err as { message?: string; stack?: string } | undefined;
  const handled = options.handled ?? true;
  enqueue({
    ts: Date.now(),
    type: 'error',
    environment: cfg.environment,
    release: cfg.release,
    message: e?.message ?? String(err),
    context: serverContext(),
    signal: {
      version: 1,
      source: 'server',
      mechanism: options.mechanism ?? (handled ? 'handled_exception' : 'framework_error'),
      handled,
      level: options.level ?? 'error',
      expected: options.expected,
      operation: options.operation,
      statusCode: options.statusCode && options.statusCode >= 100 ? options.statusCode : undefined,
    },
    payload: { stack: e?.stack, ...extra },
  });
}

export function capture(type: 'log' | 'trace', message?: string, payload?: unknown): void {
  if (!cfg?.enabled) return;
  if (cfg.sampleRate < 1 && Math.random() >= cfg.sampleRate) {countDrop('sampled');return;}
  enqueue({
    ts: Date.now(),
    type,
    environment: cfg.environment,
    release: cfg.release,
    message,
    context: serverContext(),
    payload,
  });
}

/** Capture an exception once per incoming request, preserving framework error handling. */
export function captureRequestError(error: unknown, request: object): void {
  const observation = incomingMeasurements.get(request);
  const context = requestContext.getStore();
  if (observation?.errorCaptured || context?.errorCaptured) return;
  if (context) context.errorCaptured = true;
  if (observation) observation.errorCaptured = true;
  captureError(error, undefined, {handled: false, mechanism: 'framework_error'});
}

/** Express-style error middleware — passes the original error to your handler. */
export function errorHandler() {
  return (err: unknown, req: object, _res: unknown, next: (e?: unknown) => void) => {
    captureRequestError(err, req);
    next(err);
  };
}

/**
 * Express-style middleware that turns an INBOUND webhook endpoint into a
 * monitored service with its own uptime line. Auto-detection only sees the
 * calls your app makes; a webhook is the reverse (Stripe → you), so mark the
 * route explicitly. Health comes from the status your handler responds with
 * (5xx = down). A handler that hangs past `timeoutMs` (default 10s) counts as
 * down too. Name it after the provider so it shows up branded:
 *
 *   app.post('/webhooks/stripe', webhook('stripe'), stripeHandler);
 *   app.post('/webhooks/slow', webhook('slow', { timeoutMs: 30000 }), handler);
 */
export function webhook(name: string, opts?: { timeoutMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  return (_req: unknown, res: unknown, next: (e?: unknown) => void) => {
    if (!cfg?.enabled) return next();
    const r = res as { once?: (ev: string, cb: () => void) => void; statusCode?: number };
    if (typeof r?.once === 'function') {
      let done = false;
      const record = (ok: boolean) => {
        if (done) return; // finish + timeout race — first one wins
        done = true;
        clearTimeout(timer);
        noteHost(name, ok, 'webhook');
      };
      // Hung handler never emits 'finish' — the timer counts it as down.
      const timer = setTimeout(() => record(false), timeoutMs);
      timer.unref?.();
      // 'finish' fires once the response is fully sent — statusCode is final by then.
      r.once('finish', () => record((r.statusCode ?? 500) < 500));
    }
    next();
  };
}

/**
 * Record a call to a service we can't auto-detect (a queue, a gRPC target, a
 * cron job, a driver we don't instrument). `ok` is whether the call succeeded.
 *
 *   track('payments-queue', ok, { kind: 'other' });
 */
export function track(host: string, ok: boolean, opts?: { kind?: string }): void {
  if (!cfg?.enabled) return;
  noteHost(host, ok, opts?.kind);
}

/** Explicit instrumentation for drivers that aren't safely auto-patchable. */
export const instrument = {
  /**
   * MongoDB via the driver's command monitoring. Create the client with
   * `{ monitorCommands: true }`, then pass it here once:
   *
   *   const client = new MongoClient(uri, { monitorCommands: true });
   *   instrument.mongo(client);
   */
  mongo(client: unknown): void {
    const c = client as { on?: (event: string, cb: (e: { address?: string }) => void) => void };
    if (typeof c?.on !== 'function') return;
    const record = (ok: boolean) => (e: { address?: string }) =>
      noteHost((e.address ?? 'mongodb').split(':')[0] ?? 'mongodb', ok, 'database');
    c.on('commandSucceeded', record(true));
    c.on('commandFailed', record(false));
  },
};

/** Await this before a serverless invocation or process shutdown completes. */
export function flush(): Promise<void> {
  if (pendingFlush) return pendingFlush;
  if (!cfg?.enabled) return Promise.resolve();
  const active = cfg, sender = delivery;
  const journal=durable;
  const events = queue.splice(0);
  const services = [...seenServices.entries()].map(([host, value]) => ({host, ...value}));
  seenServices.clear();
  const run = async () => {
    if(journal){await journal.ready;const recovered=journal.recover();const expired=journal.drainExpired();for(let i=events.length-1;i>=0;i--)if(expired.has(events[i]!.id!))events.splice(i,1);const ids=new Set([...events,...queue].map(event=>event.id));for(const event of recovered)if(!ids.has(event.id)){events.push(event);ids.add(event.id);}await journal.sync();}
    if(sender!==delivery)return;
    let observed = services;
    while (events.length || observed.length) {
      const currentServices = observed.splice(0, 50);
      const batch = takeBatch(events, 50, bytes(JSON.stringify(currentServices)) + 128);
      const result = await sender.send(`${active.endpoint}/ingest`, active.publicKey, {events: batch, services: currentServices}, active.transport);
      if(!result.retry)journal?.ack(batch,!result.delivered);
      if (result.retry && cfg === active) {
        queue.unshift(...batch, ...events); queue = queue.slice(-MAX_QUEUE);
        for (const item of [...currentServices, ...observed]) {
          if (!seenServices.has(item.host) && seenServices.size >= MAX_SERVICES) continue;
          const prior = seenServices.get(item.host);
          seenServices.set(item.host, {...item, ok: item.ok + (prior?.ok ?? 0), fail: item.fail + (prior?.fail ?? 0), self: item.self || prior?.self || false, kind: item.kind ?? prior?.kind});
        }
        break;
      }
      if (cfg !== active) break;
    }
    await journal?.sync();
  };
  const pending = run().finally(() => { if (pendingFlush === pending) pendingFlush = null; });
  pendingFlush = pending;
  return pending;
}

function monitorUncaughtError(error: Error, origin: NodeJS.UncaughtExceptionOrigin): void {
  captureError(error, undefined, {
    handled: false,
    mechanism: origin === 'unhandledRejection' ? 'unhandled_rejection' : 'unhandled_exception',
    level: 'fatal',
  });
  flush();
}

/** Start capturing on the server. Call once at startup. */
export function init(opts: NodeInitOptions): void {
  if (timer) return;
  if (!opts.publicKey) {
    console.warn('[everock] node init() called without a publicKey — telemetry disabled');
    return;
  }
  delivery = new DeliveryTransport();
  cfg = {
    beforeSend: opts.beforeSend,
    redactKeys: opts.redactKeys,
    transport: opts.transport,
    tracePropagationTargets: opts.tracePropagationTargets,
    publicKey: opts.publicKey,
    component: opts.component,
    serviceName: opts.serviceName,
    endpoint: (opts.endpoint ?? DEFAULTS.endpoint).replace(/\/$/, ''),
    environment: opts.environment ?? DEFAULTS.environment,
    release: opts.release,
    enabled: opts.enabled ?? DEFAULTS.enabled,
    flushIntervalMs: opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    captureRequests: opts.captureRequests??true,
    requestTimeoutMs: Math.max(100,opts.requestTimeoutMs??30000),
    sampleRate: Math.min(1, Math.max(0, opts.sampleRate ?? DEFAULTS.sampleRate)),
  };
  if (!cfg.enabled) return;
  durable=opts.persistence===false?null:new DurableQueue(opts.persistence?.store??nodeEventStore(`${cfg.endpoint}|${cfg.publicKey}|${cfg.component??'main'}`,opts.persistence?.directory),opts.persistence||{},'node');
  wrapOutbound();
  wrapInbound();
  instrumentDatabases();

  process.on('uncaughtExceptionMonitor', monitorUncaughtError);
  process.once('beforeExit', flush);

  timer = setInterval(() => flush(), cfg.flushIntervalMs);
  timer.unref?.();
}

export async function shutdown(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  process.off('uncaughtExceptionMonitor', monitorUncaughtError);
  process.off('beforeExit', flush);
  const active = cfg;
  await flush();
  if (cfg !== active) return;
  // Capture that arrived while the previous batch was in flight gets a final bounded attempt.
  await flush();
  delivery.cancel();
  cfg = null; queue = []; seenServices.clear();
}

/** Publish known route templates so unused endpoints also appear as unobserved. */
export function registerEndpoints(routes:{method:string;path:string;host:string}[]){
 if(!cfg?.enabled)return;
 const entries=routes.slice(0,500).flatMap(route=>{const value=requestMeasurement(`http://${route.host}`,route.method,0,0,{route:route.path,host:route.host});return value?[{method:value.method,path:value.path,host:value.host}]:[];});
 enqueue({ts:Date.now(),type:'trace',environment:cfg.environment,release:cfg.release,context:serverContext(),payload:{kind:'endpoint_catalog',routes:entries}});
}

/** Local diagnostics; contains no event contents, keys or collector URL. */
export function getDiagnostics(){return {...delivery.getDiagnostics(),queuedEvents:queue.length,inFlight:!!pendingFlush,droppedByReason:{...droppedByReason},droppedMemory,discardedFiltered,persistence:durable?.getDiagnostics()??null};}
