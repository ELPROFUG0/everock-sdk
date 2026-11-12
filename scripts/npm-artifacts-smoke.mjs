import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const directory = resolve(process.argv[2] ?? 'dist/npm');
const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz')).map(name => join(directory, name));
assert.equal(archives.length, 6, 'Expected exactly the six release packages');
const temporary = await mkdtemp(join(tmpdir(), 'everock-npm-smoke-'));
try {
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const archive of archives) {
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    for (const file of ['LICENSE', 'NOTICE']) assert(listing.includes(`package/${file}`), `${archive}: missing ${file}`);
    assert(!listing.some(file => /(^|\/)\.env(?:\.|$)|\.pem$|node_modules|^package\/src\//.test(file)), 'Unexpected private/source files');
    const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    if (metadata.name === '@everock/sdk') {
      const shared = JSON.parse(await readFile(resolve('packages/shared/package.json'), 'utf8'));
      assert.equal(metadata.dependencies.zod, shared.dependencies.zod, 'SDK must ship the tested validator range');
    }
    assert.equal(metadata.license, 'Apache-2.0');
    assert.equal(metadata.publishConfig.access, 'public');
    assert(!metadata.private);
    assert(!JSON.stringify(metadata.dependencies ?? {}).includes('workspace:'));
    for (const target of Object.values(metadata.exports ?? {})) {
      assert(listing.includes(`package/${target.import.slice(2)}`));
      assert(listing.includes(`package/${target.types.slice(2)}`));
    }
  }
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives, 'express@5', 'hono@4'], { cwd: temporary, stdio: 'pipe' });
  execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: temporary, stdio: 'inherit' });
  await writeFile(join(temporary, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import * as nodeSdk from '@everock/sdk/node';
    import * as edgeSdk from '@everock/sdk/edge';
    import * as config from '@everock/next/config';
    import * as server from '@everock/next/server';
    import * as provider from '@everock/next/provider';
    import * as vite from '@everock/vite';
    import * as nest from '@everock/nest';
    for (const value of [nodeSdk,edgeSdk,config,server,provider,vite,nest]) assert(Object.keys(value).length);
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: temporary, stdio: 'pipe' });
  await copyFile(resolve('scripts/fixtures/sdk-frameworks.mjs'), join(temporary, 'frameworks.mjs'));
  console.log(execFileSync(process.execPath, ['frameworks.mjs'], {cwd:temporary, encoding:'utf8', timeout:30000}));
  const cli = execFileSync(process.execPath, ['node_modules/@everock/cli/dist/index.js', '--help'], { cwd: temporary, encoding: 'utf8' });
  assert(cli.includes('everock'));
  const mcp = await readFile(join(temporary, 'node_modules/@everock/mcp/dist/index.js'), 'utf8');
  assert(!mcp.includes('require('), 'MCP must be emitted as ESM');
  console.log('PASS: six licensed archives, clean installation, adapter imports and CLI help');
} finally { await rm(temporary, { recursive: true, force: true }); }
