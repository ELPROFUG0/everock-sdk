export type {EventStore,PersistenceOptions,StoredEvent} from './persistence.js';
import {DurableQueue,type EventStore,type PersistenceOptions} from './persistence.js';
import {eventId} from './ids.js';
import {childSpan, parseTraceparent, type TraceContext} from './tracing.js';
import {DeliveryTransport, takeBatch, bytes, type TransportOptions} from './transport.js';
import {prepareEvent, type PrivacyOptions} from './privacy.js';
export type {PrivacyOptions, TelemetryEvent} from './privacy.js';
import {requestMeasurement} from './request-measurement.js';
/**
 * @everock/sdk/edge — telemetry for Cloudflare Workers and other edge runtimes.
 *
 * Unlike the Node entrypoint this module has no node:* imports. It observes
 * outbound fetches, reports their health, and captures errors explicitly from
 * a framework hook.
 */

import type { SignalLevel, SignalMechanism, TelemetrySignal } from '@everock/shared';

export interface EdgeInitOptions extends PrivacyOptions {
  /** Supply a durable adapter in an edge runtime; no local disk is assumed. */
  persistence?: PersistenceOptions & {store:EventStore};
  transport?: TransportOptions;
  component?: string;
  serviceName?: string;
  publicKey: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  enabled?: boolean;
  flushIntervalMs?: number;
}

interface EdgeConfig extends PrivacyOptions {
  transport?: TransportOptions;
  component?: string;
  serviceName?: string;
  publicKey: string;
  endpoint: string;
  environment: string;
  release?: string;
  enabled: boolean;
  flushIntervalMs: number;
}

interface Envelope {
  id?: string;
  ts: number;
  type: 'error' | 'log' | 'trace';
  environment: string;
  release?: string;
  message?: string;
  context: { platform: 'edge'; runtime: 'cloudflare-worker' };
  signal?: TelemetrySignal;
  payload?: unknown;
}

export interface EdgeCaptureErrorOptions {
  handled?: boolean;
  mechanism?: SignalMechanism;
  level?: SignalLevel;
  expected?: boolean;
  operation?: string;
  statusCode?: number;
}

let config: EdgeConfig | null = null;
let durable:DurableQueue|null=null;
const droppedByReason:Record<string,number>={};
const countDrop=(reason:string)=>{droppedByReason[reason]=(droppedByReason[reason]??0)+1;};
let delivery = new DeliveryTransport();
let endpointHost = '';
let wrapped = false;
let pendingFlush:Promise<boolean>|null=null;
let lastFlushAt = 0;
let queue: Envelope[] = [];
let services = new Map<string, { ok: number; fail: number; self: false }>();

const MAX_QUEUE = 500;
const MAX_SERVICES = 200;

function hostOf(input: RequestInfo | URL): string {
  try {
    const value = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function observe(host: string, ok: boolean): void {
  if (!host || host.length > 253 || host === endpointHost) return;
  if (!services.has(host) && services.size >= MAX_SERVICES) return;
  const current = services.get(host) ?? { ok: 0, fail: 0, self: false as const };
  if (ok) current.ok += 1;
  else current.fail += 1;
  services.set(host, current);
}

function enqueue(event: Envelope): void {
  if (!config?.enabled) return;
  const safe = prepareEvent({...event,id:event.id??eventId()}, config,countDrop);
  if (!safe) return;
  if (queue.length >= MAX_QUEUE) {queue.shift();countDrop('memory_capacity');}
  queue.push(safe);durable?.put(safe);
}
function recordHttp(url:string,method:string,status:number,started:number,direction:'inbound'|'outbound',route?:string,span?:TraceContext){
 if(!config?.enabled)return;
 try{if(direction==='outbound'&&new URL(url).origin===new URL(config.endpoint).origin)return;}catch{return;}
 const measurement=requestMeasurement(url,method,status,performance.now()-started,{direction,route});
 if(!measurement)return;

 enqueue({ts:Date.now(),type:'trace',environment:config.environment,release:config.release,context:{platform:'edge',runtime:'cloudflare-worker'},payload:{...measurement,...span,...(config.component?{component:config.component}:{}),...(config.serviceName?{service:config.serviceName}:{})}});
}

function wrapFetch(): void {
  if (wrapped || typeof globalThis.fetch !== 'function') return;
  wrapped = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = hostOf(input),raw=input instanceof Request?input.url:String(input),started=performance.now(),method=init?.method??(input instanceof Request?input.method:'GET');
    try {
      const response = await original(input, init);
      observe(host, response.status < 500);
      recordHttp(raw,method,response.status,started,'outbound');
      if (host && host !== endpointHost && response.status >= 500) {
        captureError(
          new Error(`HTTP ${response.status} from ${host}`),
          { host, statusCode: response.status,request:requestMeasurement(raw,method,response.status,performance.now()-started,{direction:'outbound'}) },
          { handled: true, mechanism: 'http_error', statusCode: response.status, operation: host },
        );
      }
      void flushIfDue();
      return response;
    } catch (error) {
      observe(host, false);
      recordHttp(raw,method,0,started,'outbound');
      if (host && host !== endpointHost) {
        captureError(error, { host,request:requestMeasurement(raw,method,0,performance.now()-started,{direction:'outbound'}) }, { handled: true, mechanism: 'network_error', operation: host });
      }
      void flushIfDue();
      throw error;
    }
  };
}

async function flushIfDue(): Promise<void> {
  if (!config || Date.now() - lastFlushAt < config.flushIntervalMs) return;
  await flush();
}

export function init(options: EdgeInitOptions): void {
  if (!options.publicKey || options.enabled === false) return;
  delivery.cancel();delivery = new DeliveryTransport();queue=[];services.clear();pendingFlush=null;durable=null;
  config = {
    beforeSend: options.beforeSend, redactKeys: options.redactKeys, transport: options.transport,
    publicKey: options.publicKey,
    component: options.component,
    serviceName: options.serviceName,
    endpoint: (options.endpoint ?? 'https://collector.everock.example').replace(/\/$/, ''),
    environment: options.environment ?? 'production',
    release: options.release,
    enabled: options.enabled ?? true,
    flushIntervalMs: Math.max(1_000, options.flushIntervalMs ?? 5_000),
  };
  try {
    endpointHost = new URL(config.endpoint).hostname;
  } catch {
    endpointHost = '';
  }
  durable=options.persistence?new DurableQueue(options.persistence.store,options.persistence):null;
  wrapFetch();
}

export function captureError(
  error: unknown,
  extra?: Record<string, unknown>,
  options: EdgeCaptureErrorOptions = {},
): void {
  if (!config?.enabled) return;
  const value = error as { message?: string; stack?: string } | undefined;
  const handled = options.handled ?? true;

  enqueue({
    ts: Date.now(),
    type: 'error',
    environment: config.environment,
    release: config.release,
    message: value?.message ?? String(error),
    context: { platform: 'edge', runtime: 'cloudflare-worker' },
    signal: {
      version: 1,
      source: 'edge',
      mechanism: options.mechanism ?? (handled ? 'handled_exception' : 'framework_error'),
      handled,
      level: options.level ?? 'error',
      expected: options.expected,
      operation: options.operation,
      statusCode: options.statusCode && options.statusCode >= 100 ? options.statusCode : undefined,
    },
    payload: { stack: value?.stack, ...extra, ...(config.component?{component:config.component}:{}), ...(config.serviceName || config.component?{service:config.serviceName??config.component}:{}) },
  });
}

export function flush():Promise<void>{
 if(pendingFlush)return pendingFlush.then(success=>{if(success&&(queue.length||services.size))return flush();});
 if(!config?.enabled||(queue.length===0&&services.size===0&&!durable))return Promise.resolve();
 pendingFlush=sendBatch();return pendingFlush.then(()=>{});
}
async function sendBatch():Promise<boolean>{
  if(!config?.enabled)return false;
  const active = config, sender = delivery,journal=durable;
  if (!active?.enabled) return false;
  lastFlushAt = Date.now();
  const events = queue.splice(0);
  let observed = [...services.entries()].map(([host, value]) => ({host, ...value}));
  services.clear();
  try {
    if(journal){await journal.ready;const recovered=journal.recover(),expired=journal.drainExpired();for(let i=events.length-1;i>=0;i--)if(expired.has(events[i]!.id!))events.splice(i,1);const ids=new Set([...events,...queue].map(e=>e.id));for(const event of recovered)if(!ids.has(event.id)){events.push(event);ids.add(event.id);}await journal.sync();}
    if(config!==active||sender!==delivery)return false;
    while (events.length || observed.length) {
      const current = observed.splice(0, 50);
      const batch = takeBatch(events, 50, bytes(JSON.stringify(current)) + 128);
      const result = await sender.send(`${active.endpoint}/ingest`, active.publicKey, {events: batch, services: current}, active.transport);
      if(!result.retry)journal?.ack(batch,!result.delivered);
      if (result.retry) {
        if (config === active) {
          queue.unshift(...batch, ...events); queue = queue.slice(-MAX_QUEUE);
          for (const item of [...current, ...observed]) {
            const prior = services.get(item.host);
            if (!prior && services.size >= MAX_SERVICES) continue;
            services.set(item.host, {ok: item.ok + (prior?.ok ?? 0), fail: item.fail + (prior?.fail ?? 0), self: false});
          }
        }
        return false;
      }
    }
    await journal?.sync();
    return true;
  } finally { if(config===active)pendingFlush = null; }
}

/** Wrap a Worker/Hono/Fetch handler without changing its response or error behavior. */
export function withRequest<A extends unknown[]>(handler:(request:Request,...args:A)=>Response|Promise<Response>,options:{route?:string}={}){
 return async(request:Request,...args:A)=>{
  const started=performance.now(),span=childSpan(parseTraceparent(request.headers.get('traceparent')));let status=0;
  try{const response=await handler(request,...args);status=response.status;if(status>=500)captureError(new Error(`HTTP ${status}`),{request:requestMeasurement(request.url,request.method,status,performance.now()-started,{route:options.route})},{handled:true,mechanism:'http_error',statusCode:status});return response;}
  catch(error){captureError(error,undefined,{handled:false,mechanism:'framework_error'});throw error;}
  finally{
   recordHttp(request.url,request.method,status,started,'inbound',options.route,span);
   const delivery=flush();
   const context=args.find(value=>value&&typeof value==='object'&&typeof (value as {waitUntil?:unknown}).waitUntil==='function') as {waitUntil:(pending:Promise<void>)=>void}|undefined;
   if(context)context.waitUntil(delivery);else void delivery;
  }
 };
}

/** Declare route templates, including endpoints that have not received traffic. */
export function registerEndpoints(routes:{method:string;path:string;host:string}[]){
 if(!config?.enabled)return;
 const entries=routes.slice(0,500).flatMap(route=>{const value=requestMeasurement(`http://${route.host}`,route.method,0,0,{route:route.path,host:route.host});return value?[{method:value.method,path:value.path,host:value.host}]:[];});

 enqueue({ts:Date.now(),type:'trace',environment:config.environment,release:config.release,context:{platform:'edge',runtime:'cloudflare-worker'},payload:{kind:'endpoint_catalog',routes:entries,component:config.component??'main'}});
}

/** Local diagnostics; contains no event contents, keys or collector URL. */
export function getDiagnostics(){return {...delivery.getDiagnostics(),queuedEvents:queue.length,inFlight:!!pendingFlush,droppedByReason:{...droppedByReason},persistence:durable?.getDiagnostics()??null};}
