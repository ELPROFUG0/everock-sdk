import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('local MCP keeps the saved CLI session bound to its API address', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'everock-session-destination-'));
  const projectId = 'fcbafc62-2cd1-4834-b326-388b1329182d';
  let requests = 0;
  const api = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer local-fixture');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === `/v1/projects/${projectId}/env?only=keys`) {
      response.end(JSON.stringify({ vars: [{ key: 'SETTING', value: 'private-fixture' }] }));
      return;
    }
    response.end('{"projects":[]}');
  });
  try {
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
    const address = api.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(join(directory, 'config.json'), JSON.stringify({ apiUrl: origin, apiKey: 'local-fixture' }));
    for (const [url, denied] of [[origin + '/other', true], [origin + '/', false]] as const) {
      const client = new Client({ name: 'destination-test', version: '1' });
      try {
        await client.connect(new StdioClientTransport({
          command: resolve(import.meta.dirname, '../node_modules/.bin/tsx'),
          args: [resolve(import.meta.dirname, '../src/index.ts')],
          env: { PATH: process.env.PATH!, EVEROCK_CONFIG_DIR: directory, EVEROCK_API_URL: url },
          stderr: 'pipe',
        }));
        const result = await client.callTool({ name: 'list_projects', arguments: {} });
        assert.equal(result.isError === true, denied);
        assert.equal(requests, denied ? 0 : 1);
        if (!denied) {
          const env = await client.callTool({ name: 'get_env', arguments: { projectId } });
          assert.notEqual(env.isError, true);
          const content = env.content as { text: string }[];
          assert.deepEqual(JSON.parse(content[0]!.text), { vars: [{ key: 'SETTING' }] });
        }
      } finally { await client.close(); }
    }
  } finally {
    api.closeAllConnections();
    api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote tools require the authenticated user even when a valid CLI session exists', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer: createMcpServer } = await import('../src/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'everock-remote-identity-'));
  const previous = process.env.EVEROCK_CONFIG_DIR;
  const server = createMcpServer('http');
  const client = new Client({ name: 'identity-test', version: '1' });
  let calls = 0;
  const api = createServer((_req, res) => { calls++; res.end('{"projects":[]}'); });
  try {
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
    const address = api.address();
    assert(address && typeof address !== 'string');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      apiUrl: 'http://127.0.0.1:' + address.port, apiKey: 'local-fixture',
    }));
    process.env.EVEROCK_CONFIG_DIR = directory;
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(right), client.connect(left)]);
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: 'Error: OAuth user identity required.' }]);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.EVEROCK_CONFIG_DIR;
    else process.env.EVEROCK_CONFIG_DIR = previous;
    await Promise.all([client.close(), server.close()]);
    api.closeAllConnections();
    api.close();
    await rm(directory, { recursive: true, force: true });
  }
});
