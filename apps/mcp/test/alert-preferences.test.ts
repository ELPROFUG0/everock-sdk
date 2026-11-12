import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {registerAlertTools} from '../src/alert-tools.js';

test('changing one alert preference preserves the project and monitor rules already in use', async t => {
  const server = new McpServer({name: 'fixture', version: '1'});
  const client = new Client({name: 'fixture', version: '1'});
  const projectId = randomUUID(), serviceId = randomUUID();
  const detectionPolicy = {windowMinutes: 12, minOccurrences: 8, minContexts: 4, serverOccurrences: 7, minRequests: 44, errorRatePercent: 7};
  const alertPolicy = {enabled: false, failureThreshold: 9, recoveryThreshold: 4, latencyWarningMs: 1200};
  const service = {id: serviceId, name: 'fixture', source: 'manual', checkEnabled: false, checkIntervalSeconds: 900, alertPolicy};
  const watcher = '/v1/projects/' + projectId + '/watcher';
  const services = '/v1/projects/' + projectId + '/services';
  const writes: unknown[] = [];
  registerAlertTools(server, async <T>(path: string, init?: {method?: string; body?: unknown}) => {
    if (init?.method === 'PATCH') {
      writes.push(init.body);
      return (path === watcher ? init.body : {service: {...service, ...init.body as object}}) as T;
    }
    assert.ok(path === watcher || path === services);
    return (path === watcher ? {detectionPolicy} : {services: [service]}) as T;
  }, handler => handler);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  t.after(() => Promise.all([server.close(), client.close()]));
  const detection = await client.callTool({name: 'update_detection_settings', arguments: {projectId, changes: {windowMinutes: 10}}});
  const monitor = await client.callTool({name: 'update_monitor_alert_settings', arguments: {projectId, serviceId, changes: {latencyWarningMs: null}}});
  assert.notEqual(detection.isError, true);
  assert.notEqual(monitor.isError, true);
  assert.deepEqual(writes, [
    {detectionPolicy: {...detectionPolicy, windowMinutes: 10}},
    {alertPolicy: {...alertPolicy, latencyWarningMs: null}},
  ]);
});
