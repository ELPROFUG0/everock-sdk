import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? join(root, 'dist/npm'));
const sdkMetadata = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8'));
const version = process.argv[3] ?? sdkMetadata.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Expected a SemVer version');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
await mkdir(destination, { recursive: true });
const sdkOutput = run(process.execPath, ['packages/sdk/scripts/pack-local.mjs', destination, version]);
const sdkTar = sdkOutput.trim().split('\n').at(-1);
console.log(sdkTar);
const temporary = await mkdtemp(join(tmpdir(), 'everock-release-'));
try {
  const sdkTypes = join(temporary, 'sdk');
  await mkdir(sdkTypes);
  run('tar', ['-xzf', sdkTar, '-C', sdkTypes]);
  for (const relative of ['packages/next', 'packages/vite', 'packages/nest', 'apps/cli', 'apps/mcp']) {
    const source = join(root, relative);
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const staging = join(temporary, metadata.name.split('/')[1]);
    await mkdir(staging);
    await writeFile(join(staging, 'package.json'), JSON.stringify(metadata));
    await cp(join(source, 'src'), join(staging, 'src'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE']) await cp(join(root, name), join(staging, name));
    try { await cp(join(source, 'README.md'), join(staging, 'README.md')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(join(staging, 'README.md'), `# ${metadata.name}\n\n${metadata.description}\n\nPart of Everock. Configure your collector URL and project key before capturing telemetry.\n\nLicensed under Apache-2.0; see LICENSE and NOTICE.\n`);
    }
    await symlink(join(source, 'node_modules'), join(staging, 'node_modules'), 'dir');
    const cli = relative.startsWith('apps/');
    await writeFile(join(staging, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: cli ? 'NodeNext' : 'ESNext', moduleResolution: cli ? 'NodeNext' : 'Bundler',
      strict: true, noUncheckedIndexedAccess: true, esModuleInterop: true, skipLibCheck: true,
      jsx: 'react-jsx', experimentalDecorators: true, emitDecoratorMetadata: true,
      declaration: true, rootDir: 'src', outDir: 'dist', types: ['node'],
      paths: { '@everock/sdk': [join(sdkTypes, 'package/dist/index.d.ts')], '@everock/sdk/*': [join(sdkTypes, 'package/dist/*.d.ts')] },
    }, include: ['src'] }));
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(staging, 'tsconfig.json')]);
    metadata.version = version;
    delete metadata.private;
    delete metadata.devDependencies;
    delete metadata.scripts;
    metadata.license = 'Apache-2.0';
    metadata.publishConfig = { access: 'public' };
    metadata.files = ['dist', 'README.md', 'LICENSE', 'NOTICE'];
    metadata.engines = { ...metadata.engines, node: '>=22' };
    metadata.dependencies = Object.fromEntries(Object.entries(metadata.dependencies ?? {}).map(([name, range]) => [name, range.startsWith('workspace:') ? version : range]));
    if (metadata.exports) metadata.exports = Object.fromEntries(Object.entries(metadata.exports).map(([key, path]) => {
      const compiled = path.replace('./src/', './dist/').replace(/\.tsx?$/, '.js');
      return [key, { types: compiled.replace(/\.js$/, '.d.ts'), import: compiled }];
    }));
    if (cli) metadata.types = './dist/index.d.ts';
    await writeFile(join(staging, 'package.json'), JSON.stringify(metadata, null, 2));
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], staging));
    console.log(join(destination, packed[0].filename));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
