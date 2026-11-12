import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoredSyncPaths, privateSyncName } from '../src/sync-policy.js';

test('Git rules protect source uploads and deleted names in a linked subdirectory', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'everock-sync-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  const app = join(repo, 'app');
  mkdirSync(app);
  writeFileSync(join(repo, '.gitignore'), '*.private\n!public.private\n');
  writeFileSync(join(app, 'tracked.private'), 'fixture');
  execFileSync('git', ['add', '-f', 'tracked.private'], { cwd: app });
  const paths = ['tracked.private', 'removed.private', 'two words.private', ':literal.private',
    'public.private', 'src.ts'];
  assert.deepEqual(ignoredSyncPaths(app, paths), new Set(paths.slice(0, 4)));
});

test('common private credential names stay excluded outside Git', () => {
  for (const name of ['.ssh', '.aws', '.netrc', '.git-credentials', 'id_ed25519', '.env.local', 'test.PEM']) {
    assert.equal(privateSyncName(name), true, name);
  }
  assert.equal(privateSyncName('keybindings.ts'), false);
});

test('an unreadable Git configuration cannot silently enable sync', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'everock-invalid-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(ignoredSyncPaths(root, ['index.ts']).size, 0);
  writeFileSync(join(root, '.git'), 'invalid');
  assert.throws(() => ignoredSyncPaths(root, ['index.ts']), /Sync stopped/);
});
