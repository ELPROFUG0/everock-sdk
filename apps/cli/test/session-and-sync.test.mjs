import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('built CLI keeps credentials private, excludes local configuration from push, and revokes on logout', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'everock-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configDir = join(cwd, 'local-session');
  const env = { ...process.env, EVEROCK_CONFIG_DIR: configDir };
  const cli = (...args) => run(process.execPath, [entry, ...args], { cwd, env });
  const calls = [];
  let revokeStatus = 503;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
    res.writeHead(req.method === 'DELETE' ? revokeStatus : 200);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = join(configDir, 'config.json');
  await cli('login', '--api-key', 'fixture', '--api-url', base);
  if (process.platform !== 'win32') assert.equal((await stat(config)).mode & 0o777, 0o600);
  await writeFile(join(cwd, '.everock.json'), JSON.stringify({ projectId: 'fixture' }));
  for (const name of ['.env', '.env.production', '.npmrc', 'private.pem', 'index.js']) {
    await writeFile(join(cwd, name), 'fixture');
  }
  await cli('push');
  const sync = calls.find(call => call.path === '/v1/projects/fixture/sync');
  assert.deepEqual(JSON.parse(sync.body).files.map(file => file.path), ['index.js']);
  await assert.rejects(cli('logout'));
  assert.equal(JSON.parse(await readFile(config, 'utf8')).apiKey, 'fixture');
  revokeStatus = 200;
  await cli('logout');
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).path, '/v1/auth/session');
  await assert.rejects(stat(config), { code: 'ENOENT' });
});
