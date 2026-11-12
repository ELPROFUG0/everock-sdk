import { setTimeout as sleep } from 'node:timers/promises';

function retryDelay(header: string | null, now: number): number {
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export async function pollDeviceToken(
  expiresIn: number,
  interval: number,
  request: (timeoutMs: number) => Promise<Response>,
  clock = { now: Date.now, sleep: (ms: number) => sleep(ms) },
): Promise<string> {
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 ||
      !Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error('Invalid login timing from the server.');
  }
  const deadline = clock.now() + expiresIn * 1000;
  let cadence = interval * 1000;
  let delay = cadence;
  while (delay < deadline - clock.now()) {
    await clock.sleep(delay);
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    const response = await request(Math.min(15_000, remaining));
    if (response.status === 429 || response.status === 503) {
      const pause = retryDelay(response.headers.get('retry-after'), clock.now());
      await response.body?.cancel();
      if (response.status === 429) cadence += 5000;
      delay = Math.max(cadence, pause, response.status === 503 ? 5000 : 0);
      continue;
    }
    const result = await response.json() as { apiKey?: string; error?: string };
    if (response.ok && typeof result.apiKey === 'string' && result.apiKey) return result.apiKey;
    if (result.error === 'slow_down') cadence += 5000;
    else if (result.error !== 'authorization_pending') throw new Error(result.error ?? 'Login failed');
    delay = cadence;
  }
  throw new Error('Login expired. Run everock login again.');
}
