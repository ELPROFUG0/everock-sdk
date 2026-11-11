import {redactUrl, type PrivacyOptions} from './privacy.js';
import {DeliveryTransport, bytes} from './transport.js';
import type { eventWithTime } from 'rrweb';

export interface SessionReplayOptions {
  /** Disabled unless explicitly enabled. */
  enabled?: boolean;
  /** Percentage of browser sessions eligible for recording, 0..1. */
  sampleRate?: number;
  /** Context retained before an error. Default 60 seconds. */
  bufferMs?: number;
  /** Context retained after the latest error. Default 20 seconds. */
  postErrorMs?: number;
  /** Upload cadence after a replay is triggered. Default 3 seconds. */
  chunkIntervalMs?: number;
  /** Mask every input value before it leaves the browser. Default true. */
  maskAllInputs?: boolean;
  /** Mask all non-input text. Default false; use data-everock-mask selectively. */
  maskAllText?: boolean;
}

export interface ReplayController {
  trigger(errorAt?: number): void;
  stop(discard?: boolean): void;
}

interface ReplayRuntimeOptions {
  privacy?: PrivacyOptions;
  isAllowed?: () => boolean;
  endpoint: string;
  publicKey: string;
  sessionId: string;
  userId: () => string | undefined;
  environment: string;
  release?: string;
  context: {
    platform?: string;
    browser?: string;
    os?: string;
    deviceType?: string;
  };
  options: Required<SessionReplayOptions>;
}

interface ActiveReplay {
  id: string;
  errorAt: number;
  startedAt: number;
  sequence: number;
  pending: eventWithTime[];
  uploadChain: Promise<void>;
  uploadFailed: boolean;
  finishTimer: ReturnType<typeof setTimeout>;
}

const MAX_CHUNK_JSON_BYTES = 600_000;

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

/** Preserve the full rrweb snapshot shape; URL redaction must never truncate DOM trees. */
function redactReplayUrls<T>(event: T): T {
  const root = structuredClone(event);
  const pending: object[] = [root as object];
  while (pending.length) {
    const node = pending.pop()! as Record<string, unknown>;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') node[key] = value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => redactUrl(raw));
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return root;
}

function sanitizeEvent(event: eventWithTime): eventWithTime {
  // rrweb EventType.Meta = 4. Clone only this small envelope; full snapshots
  // are already sanitized by rrweb's masking options and can be very large.
  if (event.type === 4 && 'href' in event.data && typeof event.data.href === 'string') {
    return { ...event, data: { ...event.data, href: sanitizeUrl(event.data.href) } };
  }
  return event;
}

function splitChunks(events: eventWithTime[]): eventWithTime[][] {
  const chunks: eventWithTime[][] = [];
  let current: eventWithTime[] = [];
  let byteCount = 2;
  for (const event of events) {
    const eventBytes = bytes(JSON.stringify(event)) + 1;
    if (current.length > 0 && byteCount + eventBytes > MAX_CHUNK_JSON_BYTES) {
      chunks.push(current);
      current = [];
      byteCount = 2;
    }
    current.push(event);
    byteCount += eventBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function startReplayRecorder(runtime: ReplayRuntimeOptions): Promise<ReplayController | null> {
  const { options } = runtime;
  if (!options.enabled || Math.random() > options.sampleRate) return null;
  const { record } = await import('rrweb');
  if (runtime.isAllowed && !runtime.isAllowed()) return null;
  let buffer: eventWithTime[] = [];
  let active: ActiveReplay | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let discarded = false;
  const sender = new DeliveryTransport();
  const postWithRetry = async (url: string, publicKey: string, body: unknown) => {
    if (discarded) return;
    const result = await sender.send(url, publicKey, body);
    if (!result.delivered && !discarded) throw new Error('Replay collector unavailable');
  };

  const basePayload = (replay: ActiveReplay) => ({
    recordingId: replay.id,
    sessionId: runtime.sessionId,
    userId: runtime.userId(),
    environment: runtime.environment,
    release: runtime.release,
    platform: runtime.context.platform,
    browser: runtime.context.browser,
    os: runtime.context.os,
    deviceType: runtime.context.deviceType,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    startedAt: replay.startedAt,
    errorAt: replay.errorAt,
  });

  const trimBuffer = (now: number) => {
    const cutoff = now - options.bufferMs;
    let start = 0;
    // Keep the most recent full snapshot at/before the desired cutoff. A replay
    // without type=2 cannot be reconstructed.
    for (let index = 0; index < buffer.length; index++) {
      const event = buffer[index]!;
      if (event.type === 2 && event.timestamp <= cutoff) start = index;
    }
    if (start > 0 && buffer[start - 1]?.type === 4) start -= 1;
    buffer = buffer.slice(start);
  };

  const enqueueUpload = (replay: ActiveReplay, events: eventWithTime[]) => {
    for (const chunk of splitChunks(events)) {
      const sequence = replay.sequence++;
      const startedAt = chunk[0]?.timestamp ?? replay.errorAt;
      const endedAt = chunk[chunk.length - 1]?.timestamp ?? startedAt;
      replay.uploadChain = replay.uploadChain.then(async () => {
        if (discarded) return;
        try {
          await postWithRetry(`${runtime.endpoint}/ingest/replay`, runtime.publicKey, {
            ...basePayload(replay),
            sequence,
            startedAt,
            endedAt,
            events: chunk,
          });
        } catch (error) {
          replay.uploadFailed = true;
          console.warn('[everock] session replay chunk upload failed', { sequence, error });
        }
      });
    }
  };

  const flushActive = () => {
    if (!active || active.pending.length === 0) return;
    const events = active.pending.splice(0, active.pending.length);
    enqueueUpload(active, events);
  };

  const finishActive = async () => {
    const replay = active;
    if (!replay) return;
    active = null;
    if (replay.pending.length > 0) {
      const tail = replay.pending.splice(0, replay.pending.length);
      enqueueUpload(replay, tail);
    }
    try {
      await replay.uploadChain;
      if (discarded) return;
      await postWithRetry(`${runtime.endpoint}/ingest/replay/finalize`, runtime.publicKey, {
        ...basePayload(replay),
        endedAt: Date.now(),
        failed: replay.uploadFailed,
      });
    } catch (error) {
      console.warn('[everock] session replay upload failed', error);
    }
  };

  const trigger = (errorAt = Date.now()) => {
    if (stopped || runtime.isAllowed && !runtime.isAllowed()) return;
    if (active) {
      active.errorAt = Math.min(active.errorAt, errorAt);
      clearTimeout(active.finishTimer);
      active.finishTimer = setTimeout(() => void finishActive(), options.postErrorMs);
      return;
    }
    const snapshot = [...buffer];
    const startedAt = snapshot[0]?.timestamp ?? errorAt;
    const replay: ActiveReplay = {
      id: uuid(),
      errorAt,
      startedAt,
      sequence: 0,
      pending: [],
      uploadChain: Promise.resolve(),
      uploadFailed: false,
      finishTimer: setTimeout(() => void finishActive(), options.postErrorMs),
    };
    active = replay;
    enqueueUpload(replay, snapshot);
  };

  const stopRecording = record({
    emit(event) {
      if (stopped || runtime.isAllowed && !runtime.isAllowed()) return;
      const safe = sanitizeEvent(redactReplayUrls(event));
      buffer.push(safe);
      trimBuffer(safe.timestamp);
      if (active) active.pending.push(safe);
    },
    checkoutEveryNms: Math.min(30_000, Math.max(10_000, Math.floor(options.bufferMs / 2))),
    blockSelector: '.everock-block,[data-everock-block]',
    ignoreSelector: '.everock-ignore,[data-everock-ignore]',
    maskTextSelector: options.maskAllText ? '*' : '.everock-mask,[data-everock-mask]',
    maskAllInputs: options.maskAllInputs,
    recordCanvas: false,
    recordCrossOriginIframes: false,
    inlineImages: false,
    collectFonts: false,
    slimDOMOptions: true,
    sampling: { mousemove: 100, scroll: 150, input: 'last' },
  });

  const onPageHide = () => {
    if (!active) return;
    clearTimeout(active.finishTimer);
    void finishActive();
  };
  window.addEventListener('pagehide', onPageHide);
  flushTimer = setInterval(flushActive, options.chunkIntervalMs);
  return {
    trigger,
    stop(discard = false) {
      stopped = true;
      discarded = discard;
      if (discard) sender.cancel();
      window.removeEventListener('pagehide', onPageHide);
      stopRecording?.();
      if (flushTimer) clearInterval(flushTimer);
      if (active) {
        clearTimeout(active.finishTimer);
        if (discard) { active.pending = []; active = null; }
        else void finishActive();
      }
      buffer = [];
    },
  };
}
