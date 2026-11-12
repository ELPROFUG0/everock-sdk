import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const privateNames = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '_netrc',
  '.git-credentials', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519',
  'id_ecdsa', 'id_dsa', '.env',
]);

export function privateSyncName(name: string): boolean {
  const lower = name.toLowerCase();
  return privateNames.has(lower) || lower.startsWith('.env.') ||
    /\.(pem|key|p12|pfx)$/i.test(name);
}

// Apply the same Git rules to initial uploads, watch updates and delete notices.
// --no-index keeps a locally ignored credential private even if previously tracked.
export function ignoredSyncPaths(root: string, paths: string[]): Set<string> {
  let directory = root;
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (directory === parent) return new Set();
    directory = parent;
  }

  const ignored = new Set<string>();
  for (let start = 0; start < paths.length; start += 512) {
    const batch = paths.slice(start, start + 512);
    const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: root,
      input: batch.map(name => './' + name).join('\0') + '\0',
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error('Sync stopped because Git ignore rules could not be checked.');
    }
    for (const name of result.stdout.split('\0')) if (name) ignored.add(name.replace(/^\.\//, ''));
  }
  return ignored;
}
