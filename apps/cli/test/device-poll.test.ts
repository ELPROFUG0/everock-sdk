import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDeviceToken } from '../src/device-poll.js';

function fixture(responses: Response[]) {
  const start = Date.UTC(2026, 0, 1);
  let now = start;
  const calls: number[] = [];
  return {
    calls, start,
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    request: async () => {
      calls.push((now - start) / 1000);
      const next = responses.shift();
      assert.ok(next, 'Unexpected device poll');
      return next;
    },
  };
}

test('honors edge delay, then resumes at the reduced polling rate', async () => {
  const f = fixture([
    new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
    Response.json({ error: 'authorization_pending' }, { status: 428 }),
    Response.json({ apiKey: 'fixture' }),
  ]);
  assert.equal(await pollDeviceToken(600, 3, f.request, f.clock), 'fixture');
  assert.deepEqual(f.calls, [3, 63, 71]);
});

test('a temporary outage supports an HTTP-date even with a non-JSON response', async () => {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 20)).toUTCString();
  const f = fixture([new Response('Busy', {status: 503, headers: {'retry-after': date}}), Response.json({apiKey:'fixture'})]);
  await pollDeviceToken(60, 3, f.request, f.clock);
  assert.deepEqual(f.calls, [3, 20]);
});

test('ends without another request when the next poll would reach expiry', async () => {
  const f = fixture([new Response(null, {status:429, headers:{'retry-after':'60'}})]);
  await assert.rejects(pollDeviceToken(63, 3, f.request, f.clock), /expired/);
  assert.deepEqual(f.calls, [3]);
});

test('a denied authorization stops the poll immediately', async () => {
  const f = fixture([Response.json({error:'access_denied'}, {status:400})]);
  await assert.rejects(pollDeviceToken(600, 3, f.request, f.clock), /access_denied/);
  assert.deepEqual(f.calls, [3]);
});
