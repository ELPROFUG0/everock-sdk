import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
/** Detection is an installation hint, not proof of runtime instrumentation. */
export function detectFramework(directory: string): {framework?:string; detectedKind:'web'|'api'|'worker'|'mobile'|'other'} {
  try {
    const manifest=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    const deps={...manifest.dependencies,...manifest.devDependencies};
    // Server frameworks take precedence over a transitive/present UI library.
    const framework=[['next','Next.js'],['@sveltejs/kit','SvelteKit'],['astro','Astro'],['nuxt','Nuxt'],['expo','Expo'],['react-native','React Native'],['fastify','Fastify'],['express','Express'],['hono','Hono'],['@nestjs/core','NestJS'],['react','React'],['vue','Vue'],['svelte','Svelte']].find(([dependency])=>dependency! in deps)?.[1];
    const worker=['wrangler.toml','wrangler.jsonc','wrangler.json'].some(file=>existsSync(join(directory,file)))||'bullmq' in deps;
    return {framework,detectedKind:worker?'worker':['React Native','Expo'].includes(framework??'')?'mobile':['Fastify','Express','Hono','NestJS'].includes(framework??'')?'api':framework?'web':'other'};
  } catch { /* Python repositories may not have package.json. */ }
  const files=['pyproject.toml','requirements.txt','Pipfile'];
  const source=files.flatMap(file=>{try{return [readFileSync(join(directory,file),'utf8').replace(/^\s*#.*$/gm,'')];}catch{return [];}}).join('\n');
  for(const [dependency,framework] of [['fastapi','FastAPI'],['django','Django'],['flask','Flask']]) {
    if(new RegExp(`(?:^|[\\s"'])${dependency}(?:[\\s"'\\[<>=!~]|$)`,'im').test(source))return {framework,detectedKind:'api'};
  }
  return {framework:source?'Python':undefined,detectedKind:'other'};
}
