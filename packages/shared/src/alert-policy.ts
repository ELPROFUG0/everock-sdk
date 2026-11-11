import {z} from 'zod';
/** Per-monitor hysteresis. Availability checks remain separately opt-in. */
export const MonitorAlertPolicy = z.object({
  enabled: z.boolean().default(true),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  recoveryThreshold: z.number().int().min(1).max(20).default(2),
  latencyWarningMs: z.number().int().min(50).max(60000).nullable().default(null),
});
export type MonitorAlertPolicy = z.infer<typeof MonitorAlertPolicy>;
export function monitorAlertPolicy(value: unknown): MonitorAlertPolicy {
  const parsed=MonitorAlertPolicy.safeParse(value ?? {});
  return parsed.success ? parsed.data : MonitorAlertPolicy.parse({});
}
export function checkState(policy:MonitorAlertPolicy,result:{up:boolean;latencyMs:number|null}):'healthy'|'warning'|'down'{
  if(!result.up)return 'down';
  return policy.latencyWarningMs!==null && result.latencyMs!==null && result.latencyMs>policy.latencyWarningMs ? 'warning' : 'healthy';
}
/** Optional traffic gate. Disabled percentage/volume gates preserve existing installations. */
export const DetectionPolicy=z.object({
 windowMinutes:z.number().int().min(1).max(60).default(5),
 minOccurrences:z.number().int().min(2).max(1000).default(5),
 minContexts:z.number().int().min(1).max(100).default(2),
 serverOccurrences:z.number().int().min(2).max(1000).default(10),
 minRequests:z.number().int().min(0).max(100000).default(0),
 errorRatePercent:z.number().min(0).max(100).default(0),
});
export type DetectionPolicy=z.infer<typeof DetectionPolicy>;
export function detectionPolicy(value:unknown):DetectionPolicy{const parsed=DetectionPolicy.safeParse(value??{});return parsed.success?parsed.data:DetectionPolicy.parse({});}
