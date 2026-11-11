import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createRequire} from 'node:module';
import { execFileSync } from 'node:child_process';
const sdk=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const packageMetadata=JSON.parse(await readFile(join(sdk,'package.json'),'utf8'));
const destination=resolve(process.argv[2]??'.'),version=process.argv[3]??packageMetadata.version;
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('Use a versioned SemVer package');
const temporary=await mkdtemp(join(tmpdir(),'everock-sdk-pack-'));
try {
  await mkdir(destination,{recursive:true});
  await cp(join(sdk,'src'),join(temporary,'src'),{recursive:true});
  await cp(join(sdk,'bin'),join(temporary,'bin'),{recursive:true});
  await cp(join(sdk,'README.md'),join(temporary,'README.md'));
  for (const name of ['LICENSE', 'NOTICE']) await cp(resolve(sdk, '../..', name), join(temporary, name));
  for(const name of ['signals','browser-settings','alert-policy'])await cp(resolve(sdk,`../shared/src/${name}.ts`),join(temporary,`src/${name}.ts`));
  for(const name of await readdir(join(temporary,'src'))) {
    const path=join(temporary,'src',name);
    if(!name.endsWith('.ts'))continue;
    let source=await readFile(path,'utf8');
    source=source.replaceAll("from '@everock/shared/browser-settings'","from './browser-settings.js'").replaceAll("from '@everock/shared'","from './signals.js'");
    await writeFile(path,source);
  }
  await symlink(join(sdk,'node_modules'),join(temporary,'node_modules'),'dir');
  await writeFile(join(temporary,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ES2022','DOM'],module:'ESNext',moduleResolution:'Bundler',strict:true,noUncheckedIndexedAccess:true,esModuleInterop:true,skipLibCheck:true,paths:{zod:[resolve(sdk,'../shared/node_modules/zod')]},declaration:true,rootDir:'src',outDir:'dist'},include:['src']}));
  const require=createRequire(import.meta.url);
  execFileSync(process.execPath,[require.resolve('typescript/bin/tsc'),'--project',join(temporary,'tsconfig.json')],{stdio:['ignore','inherit','inherit']});
  const metadata=packageMetadata;
  metadata.main='./dist/index.js';metadata.types='./dist/index.d.ts';
  metadata.exports=Object.fromEntries(Object.entries(metadata.exports).map(([key,path])=>[key,{types:path.replace('./src/','./dist/').replace('.ts','.d.ts'),import:path.replace('./src/','./dist/').replace('.ts','.js')} ]));
  metadata.version=version;delete metadata.dependencies['@everock/shared'];
  const sharedMetadata = JSON.parse(await readFile(resolve(sdk, '../shared/package.json'), 'utf8'));
  metadata.dependencies.zod = sharedMetadata.dependencies.zod;
  delete metadata.private;delete metadata.devDependencies;metadata.files=['dist','bin','README.md','LICENSE','NOTICE'];metadata.publishConfig={access:'public'};delete metadata.scripts;
  await writeFile(join(temporary,'package.json'),JSON.stringify(metadata,null,2));
  const output=execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',destination],{cwd:temporary,encoding:'utf8'});
  console.log(join(destination,JSON.parse(output)[0].filename));
} finally {await rm(temporary,{recursive:true,force:true});}
