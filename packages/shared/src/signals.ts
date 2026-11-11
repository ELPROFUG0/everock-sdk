import {detectionPolicy,type DetectionPolicy} from './alert-policy.js';
import { z } from 'zod';

/** Runtime that observed a telemetry signal. */
export const SignalSource = z.enum([
  'browser',
  'server',
  'edge',
  'mobile',
  'worker',
  'infrastructure',
  'monitor',
  'custom',
]);
export type SignalSource = z.infer<typeof SignalSource>;

/** What actually produced the signal, independent of framework or language. */
export const SignalMechanism = z.enum([
  'unhandled_exception',
  'unhandled_rejection',
  'framework_error',
  'handled_exception',
  'http_error',
  'network_error',
  'dependency_failure',
  'console_error',
  'log_pattern',
  'process_crash',
  'out_of_memory',
  'timeout',
  'missed_heartbeat',
  'business_failure',
  'manual',
]);
export type SignalMechanism = z.infer<typeof SignalMechanism>;

export const SignalLevel = z.enum(['debug', 'info', 'warning', 'error', 'fatal']);
export type SignalLevel = z.infer<typeof SignalLevel>;

/**
 * Versioned contract shared by every SDK. Framework adapters describe a
 * signal here; the ingest classifier decides whether it is evidence, an
 * anomaly, or a problem. This keeps capture broad without paging on noise.
 */
export const TelemetrySignal = z.object({
  version: z.literal(1),
  source: SignalSource,
  mechanism: SignalMechanism,
  handled: z.boolean(),
  level: SignalLevel,
  expected: z.boolean().optional(),
  statusCode: z.preprocess(value => value === 0 ? undefined : value, z.number().int().min(100).max(599).optional()),
  operation: z.string().trim().min(1).max(300).optional(),
});
export type TelemetrySignal = z.infer<typeof TelemetrySignal>;

export type EnvironmentTier = 'production' | 'preproduction' | 'development' | 'test' | 'unknown';
export type DetectionDisposition = 'evidence' | 'anomaly' | 'incident';

export interface SignalClassification {
  disposition: DetectionDisposition;
  environmentTier: EnvironmentTier;
  reason: string;
  confidence: number;
}

export interface AnomalyWindow {
  occurrences: number;
  sessions: number;
  users: number;
}

/**
 * Correlation gate for ambiguous failures. A single 5xx or timeout is useful
 * evidence, not necessarily a problem. Repeated failures become a problem
 * once they affect more than one execution context, or become sufficiently
 * frequent even when a server/worker cannot attach a session identity.
 */
export function shouldPromoteAnomaly(window: AnomalyWindow,policy?:DetectionPolicy): boolean {
  const p=detectionPolicy(policy);
  if (window.occurrences < p.minOccurrences) return false;
  return window.sessions >= p.minContexts || window.users >= p.minContexts || window.occurrences >= p.serverOccurrences;
}

export function environmentTier(environment?: string | null): EnvironmentTier {
  const value = (environment ?? '').trim().toLowerCase();
  if (/^(prod|production|live)$/.test(value)) return 'production';
  if (/^(preview|staging|stage|preprod|pre-production|canary|qa|uat)$/.test(value)) {
    return 'preproduction';
  }
  if (/^(dev|development|local|localhost)$/.test(value)) return 'development';
  if (/^(test|testing|ci|e2e)$/.test(value)) return 'test';
  return 'unknown';
}

const DEFINITIVE = new Set<SignalMechanism>([
  'unhandled_exception',
  'unhandled_rejection',
  'framework_error',
  'process_crash',
  'out_of_memory',
  'missed_heartbeat',
]);

/** Pure deterministic policy. It deliberately contains no AI judgment. */
export function classifyTelemetrySignal(
  signal: TelemetrySignal,
  environment?: string | null,
): SignalClassification {
  const tier = environmentTier(environment);

  if (signal.expected) {
    return { disposition: 'evidence', environmentTier: tier, reason: 'expected_signal', confidence: 1 };
  }

  // Development and tests remain fully observable without filling production
  // Inbox. The raw event, stack and context are still retained.
  if (tier === 'development' || tier === 'test') {
    return {
      disposition: 'evidence',
      environmentTier: tier,
      reason: 'non_alerting_environment',
      confidence: 1,
    };
  }

  if (DEFINITIVE.has(signal.mechanism) && !signal.handled) {
    return {
      disposition: 'incident',
      environmentTier: tier,
      reason: 'definitive_unhandled_failure',
      confidence: 1,
    };
  }

  if (signal.level === 'fatal' && !signal.handled) {
    return {
      disposition: 'incident',
      environmentTier: tier,
      reason: 'explicit_fatal_failure',
      confidence: 0.95,
    };
  }

  if (signal.mechanism === 'http_error') {
    if ((signal.statusCode ?? 0) >= 500) {
      return {
        disposition: 'anomaly',
        environmentTier: tier,
        reason: 'server_response_requires_correlation',
        confidence: 0.75,
      };
    }
    return { disposition: 'evidence', environmentTier: tier, reason: 'client_response', confidence: 0.9 };
  }

  if (
    signal.mechanism === 'network_error' ||
    signal.mechanism === 'dependency_failure' ||
    signal.mechanism === 'timeout' ||
    signal.mechanism === 'business_failure'
  ) {
    return {
      disposition: 'anomaly',
      environmentTier: tier,
      reason: 'failure_requires_correlation',
      confidence: 0.7,
    };
  }

  return {
    disposition: 'evidence',
    environmentTier: tier,
    reason: signal.handled ? 'handled_failure' : 'weak_signal',
    confidence: 0.9,
  };
}

/** Compatibility for SDK versions that predate the signal contract. */
export function legacySignal(input: {
  platform?: string | null;
  payload?: unknown;
}): TelemetrySignal {
  const payload = (input.payload ?? {}) as { unhandledRejection?: unknown };
  const source: SignalSource = input.platform === 'server' ? 'server' : 'browser';
  return {
    version: 1,
    source,
    mechanism: payload.unhandledRejection === true ? 'unhandled_rejection' : 'unhandled_exception',
    handled: false,
    level: 'error',
  };
}
