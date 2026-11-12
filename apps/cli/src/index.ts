#!/usr/bin/env node
import {detectFramework} from './detect-framework.js';
/**
 * Everock CLI — runs on the developer's machine.
 *
 *   everock login  --api-key ak_…   [--api-url http://localhost:4000]
 *   everock link   --project-id <uuid>
 *   everock dev                      # watch cwd, sync every save → hot reload in the cloud
 *   everock push                     # one-shot full sync
 *   everock logs   [--errors]        # recent request logs
 *   everock deploy                   # publish (dev → prod)
 *   everock rollback --sha <sha>
 *
 * Auth is a personal API key (see the "Conectar" modal). The linked project id
 * lives in ./.everock.json so `dev` knows what to sync.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import chokidar from 'chokidar';
import { pollDeviceToken } from './device-poll.js';
import { ignoredSyncPaths, privateSyncName } from './sync-policy.js';

// ─── config (global key) + link (per-project, in cwd) ───
const CONFIG_DIR = resolve(process.env.EVEROCK_CONFIG_DIR ?? join(homedir(), '.everock'));
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const LINK_FILE = join(process.cwd(), '.everock.json');

interface Config {
  apiKey: string;
  apiUrl: string;
}
const readConfig = (): Config | null =>
  existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : null;
const readLink = (): { projectId: string; component?: string } | null =>
  existsSync(LINK_FILE) ? JSON.parse(readFileSync(LINK_FILE, 'utf8')) : null;

function requireCtx(): { cfg: Config; projectId: string; component: string } {
  const cfg = readConfig();
  if (!cfg?.apiKey) die('No has iniciado sesión. Corre:  everock login --api-key ak_…');
  const link = readLink();
  if (!link?.projectId) die('Proyecto no enlazado. Corre:  everock link --project-id <id>');
  return { cfg: cfg!, projectId: link!.projectId, component: link!.component ?? 'main' };
}

// ─── tiny helpers ───
const log = (m: string) => console.log(m);
function die(m: string): never {
  console.error(`✗ ${m}`);
  process.exit(1);
}

async function apiCall<T>(
  cfg: Config,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  safeWebUrl(cfg.apiUrl);
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    redirect: 'error',
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${(data && data.error) || res.statusText}`);
  return data as T;
}

// ─── file collection (respecting a minimal ignore set) ───
const IGNORE = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.everock',
  '.everock.json',
  // Protect credentials left by older local installations as well.
  '.agenthost',
  '.agenthost.json',
  '.DS_Store',
]);
const MAX_FILE = 10 * 1024 * 1024; // 10 MB per file

function excludedFromSync(name: string): boolean {
  return IGNORE.has(name) || privateSyncName(name);
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (excludedFromSync(name)) continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (full === CONFIG_FILE || (full === CONFIG_DIR && full !== root)) continue;
    if (st.isDirectory()) walk(root, full, out);
    else if (st.isFile() && st.size <= MAX_FILE) out.push(full);
  }
  return out;
}

const toRel = (root: string, full: string) => relative(root, full).split(sep).join('/');
const readB64 = (full: string) => readFileSync(full).toString('base64');

const LOGO_CANDIDATES = [
  'public/favicon.svg',
  'public/icon.svg',
  'public/logo.svg',
  'public/favicon.png',
  'public/icon.png',
  'public/logo.png',
  'src/app/icon.svg',
  'src/app/icon.png',
  'app/icon.svg',
  'app/icon.png',
  'public/favicon.ico',
  'src/app/favicon.ico',
  'app/favicon.ico',
  'public/logo.webp',
  'public/favicon.webp',
  'public/logo.jpg',
  'public/logo.jpeg',
] as const;

function logoContentType(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  return null;
}

function detectProjectLogo(root: string) {
  for (const relativePath of LOGO_CANDIDATES) {
    const full = join(root, relativePath);
    if (!existsSync(full) || realpathSync(full) !== full) continue;
    const stat = lstatSync(full);
    const contentType = logoContentType(relativePath);
    if (!stat.isFile() || !contentType || stat.size === 0 || stat.size > 256 * 1024) continue;
    return { contentType, data: readB64(full), sourcePath: relativePath };
  }
  return null;
}

async function syncFiles(cfg: Config, projectId: string, files: string[], deletes: string[]) {
  if (!files.length && !deletes.length) return;
  const root = process.cwd();
  const ignored = ignoredSyncPaths(root, [...files.map(file => toRel(root, file)), ...deletes]);
  const eligible = (path: string) => {
    const full = resolve(root, path);
    return full !== CONFIG_FILE && !(CONFIG_DIR !== root && full.startsWith(CONFIG_DIR + sep)) &&
      !ignored.has(path) && !path.split('/').some(excludedFromSync) && !path.startsWith('../');
  };
  const publicDeletes = deletes.filter(eligible);
  const payload = files.flatMap((file) => {
    const path = toRel(root, file);
    if (!eligible(path)) return [];
    let content: string;
    try {
      if (realpathSync(file) !== file) return [];
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) return [];
      content = readB64(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return [{ path, content }];
  });
  if (!payload.length && !publicDeletes.length) return;
  await apiCall(cfg, `/v1/projects/${projectId}/sync`, {
    method: 'POST',
    body: {
      files: payload,
      deletes: publicDeletes,
    },
  });
}

// ─── commands ───
function saveSession(cfg:Config){
  mkdirSync(CONFIG_DIR,{recursive:true,mode:0o700});
  chmodSync(CONFIG_DIR,0o700);
  const temporary = join(CONFIG_DIR, `session-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(cfg, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, CONFIG_FILE);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function safeWebUrl(value: string): URL {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !localHttp)) {
    throw new Error('Use an HTTPS URL or HTTP on localhost.');
  }
  return url;
}
function openBrowser(url:string){
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
  const child=spawn(command,[safeWebUrl(url).href],{stdio:'ignore',detached:true});
  child.on('error',()=>{});child.unref();
}
async function cmdLogin(apiKey?:string,apiUrl?:string,noBrowser=false){
  const base=(apiUrl??process.env.EVEROCK_API_URL??readConfig()?.apiUrl??'http://localhost:4000').replace(/\/$/,'');
  safeWebUrl(base);
  if(apiKey){
    const cfg={apiKey,apiUrl:base};await apiCall(cfg,'/v1/projects');saveSession(cfg);log('✓ Signed in');return;
  }
  const start=await fetch(`${base}/auth/cli/start`,{redirect:'error',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientName:'Everock CLI'}),signal:AbortSignal.timeout(15000)});
  if(!start.ok)die(`Unable to start login (${start.status})`);
  const flow=await start.json() as {deviceCode:string;userCode:string;verificationUrl:string;expiresIn:number;interval:number};
  safeWebUrl(flow.verificationUrl);
  log(`Open ${flow.verificationUrl}\nEnter code: ${flow.userCode}\nApprove this CLI once, then return to your agent.`);
  if(!noBrowser)openBrowser(flow.verificationUrl);
  const token = await pollDeviceToken(flow.expiresIn, flow.interval, timeoutMs =>
    fetch(`${base}/auth/cli/token`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: flow.deviceCode }), signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  saveSession({ apiKey: token, apiUrl: base });
  log('✓ Signed in. Your agent can now use the CLI and local MCP.');
}
async function cmdLogout(localOnly: boolean){
 const cfg=readConfig();if(!cfg){log('Already signed out');return;}
 if (localOnly) {
   unlinkSync(CONFIG_FILE);
   log('Local credentials removed. Remote revocation was not requested.');
   return;
 }
 await apiCall(cfg,'/v1/auth/session',{method:'DELETE'});
 unlinkSync(CONFIG_FILE);log('✓ Session revoked and removed');
}
async function cmdGithub(noBrowser=false){
 const cfg=readConfig();if(!cfg)die('Run everock login first.');
 const result=await apiCall<{connected:boolean;installations:number[];authorizeUrl:string;installUrl:string|null}>(cfg!,'/v1/auth/github');
 if(result.connected&&result.installations.length){log('✓ GitHub connected. Your agent can connect authorized repositories.');return;}
 const url=result.connected?result.installUrl:result.authorizeUrl;
 if(!url)die('GitHub App is not configured on the server.');
 log(`Complete the initial GitHub authorization: ${url}\nThen repeat everock github connect or everock link.`);
 if(!noBrowser)openBrowser(url);
}
async function cmdProjects(name?:string){
 const cfg=readConfig();if(!cfg)die('Run everock login first.');
 if(name){
  const result=await apiCall<{project:{id:string}}>(cfg!,'/v1/projects/setup',{method:'POST',body:{name,requestId:crypto.randomUUID()}});
  const {secretOnce,...safe}=result as typeof result & {secretOnce?:string};
  log(JSON.stringify(safe));return result.project.id;
 }
 const result=await apiCall(cfg!,'/v1/projects');log(JSON.stringify(result,null,2));
}
async function cmdInit(name?:string,projectId?:string,component='main'){
 const id=projectId??(name?await cmdProjects(name):undefined);
 if(!id)die('Use everock init --name "My app" or --project-id ID. List existing projects with everock projects.');
 await cmdLink(id,component);
 const {cfg}=requireCtx();
 const keys=await apiCall<{publicKey:string}>(cfg,`/v1/projects/${id}/keys`);
 log(JSON.stringify({projectId:id,component,sdk:{publicKey:keys.publicKey,endpoint:cfg.apiUrl,component},next:'Install the SDK for this runtime, configure it with these public values, run the app and verify received events. No source files were uploaded.'},null,2));
}

async function cmdLink(projectId?: string, component = 'main', localOnly = false) {
  if (!projectId) die('Falta --project-id <uuid>');
  const cfg = readConfig();
  if (!cfg?.apiKey) die('Inicia sesión primero:  everock login --api-key ak_…');
  const project = await apiCall<{ slug: string }>(cfg!, `/v1/projects/${projectId}`).catch(() =>
    die('Proyecto no encontrado (¿es tuyo?).'),
  );
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(component) || component.length > 48) die('Identificador de componente inválido.');
  const available = await apiCall<{components: {slug:string}[]}>(cfg!, `/v1/projects/${projectId}/components`);
  if (!available.components.some(item => item.slug === component)) await apiCall(cfg!,`/v1/projects/${projectId}/components`,{method:'POST',body:{slug:component,name:component,kind:'other',defaultBranch:'main',workingDirectory:''}});
  const temporaryLink = LINK_FILE + '.' + randomUUID() + '.tmp';
  writeFileSync(temporaryLink, JSON.stringify({ projectId, component }, null, 2), { flag: 'wx' });
  try {
    renameSync(temporaryLink, LINK_FILE);
  } catch (error) {
    unlinkSync(temporaryLink);
    throw error;
  }
  log(`✓ Enlazado a "${project.slug}" · escrito ${LINK_FILE}`);

  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
    if (match) {
      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (defaultBranch) {
        const {framework, detectedKind} = detectFramework(process.cwd());
        await apiCall(cfg!, `/v1/projects/${projectId}/repository-identity`, {
          method: 'POST', body: { repo: match[1], defaultBranch, component, framework, detectedKind, workingDirectory: relative(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),process.cwd()).split(sep).join('/') },
        });
        log(`✓ Repositorio detectado · ${match[1]}`);
        if(!localOnly){
          try{
            await apiCall(cfg!,`/v1/projects/${projectId}/components/${component}/repository`,{method:'PATCH',body:{repo:match[1],defaultBranch,workingDirectory:relative(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),process.cwd()).split(sep).join('/')}});
            log('✓ Integración de GitHub conectada.');
          }catch(error){
            log(`! GitHub no conectado: ${(error as Error).message}`);
            const links=await apiCall<{githubInstallUrl:string|null;githubAuthorizeUrl?:string;githubConfigured:boolean}>(cfg!,`/v1/projects/${projectId}/component-connections`).catch(()=>null);
            if(links?.githubAuthorizeUrl||links?.githubInstallUrl)log(`Authorize GitHub once, then repeat link: ${links.githubAuthorizeUrl??links.githubInstallUrl}`);
            else log('El servidor necesita configurar su GitHub App. El SDK puede instalarse mientras tanto.');
          }
        }
      }
    }
  } catch {
    log('· No se pudo registrar el origen Git. Puedes completar la conexión en Settings → Integrations.');
  }

  log('✓ Checkout vinculado sin subir archivos locales.');
}

async function cmdPush() {
  const { cfg, projectId, component } = requireCtx();
  if (component !== 'main') die('Los comandos de hosting administrado solo admiten main. Despliega este componente con tu proveedor y configura su SDK.');
  const files = walk(process.cwd());
  log(`Subiendo ${files.length} archivos…`);
  await syncFiles(cfg, projectId, files, []);
  log('✓ Sincronizado.');
}

async function cmdDev() {
  const { cfg, projectId, component } = requireCtx();
  if (component !== 'main') die('Los comandos de hosting administrado solo admiten main. Despliega este componente con tu proveedor y configura su SDK.');
  const root = process.cwd();
  log('↑ Subida inicial…');
  await cmdPushSilent(cfg, projectId);
  log('✓ Listo. Observando cambios (Ctrl-C para salir).');

  // Coalesce rapid saves into one batched sync.
  const changed = new Set<string>();
  const removed = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const files = [...changed];
    const dels = [...removed];
    changed.clear();
    removed.clear();
    syncFiles(cfg, projectId, files, dels)
      .then(() => log(`⟳ sync · ${files.length} cambios${dels.length ? `, ${dels.length} borrados` : ''}`))
      .catch((e) => console.error(`✗ sync: ${e.message}`));
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 150);
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p: string) => relative(root, p).split(sep).some(excludedFromSync),
  });
  watcher
    .on('add', (p) => {
      removed.delete(toRel(root, p));
      changed.add(p);
      schedule();
    })
    .on('change', (p) => {
      changed.add(p);
      schedule();
    })
    .on('unlink', (p) => {
      const rel = toRel(root, p);
      changed.forEach((f) => {
        if (toRel(root, f) === rel) changed.delete(f);
      });
      removed.add(rel);
      schedule();
    });
}

async function cmdPushSilent(cfg: Config, projectId: string) {
  await syncFiles(cfg, projectId, walk(process.cwd()), []);
}

async function cmdLogs(errors: boolean) {
  const { cfg, projectId } = requireCtx();
  const p = new URLSearchParams({ projectId });
  if (errors) p.set('level', 'error');
  const { logs } = await apiCall<{ logs: { ts: string; method: string; status: number; path: string; latencyMs: number }[] }>(
    cfg,
    `/v1/logs/requests?${p.toString()}`,
  );
  if (!logs.length) return log('(sin peticiones)');
  for (const l of logs) {
    log(`${new Date(l.ts).toLocaleTimeString('es-MX', { hour12: false })}  ${l.method} ${l.status}  ${l.path}  ${l.latencyMs}ms`);
  }
}

async function cmdDeploy() {
  const { cfg, projectId, component } = requireCtx();
  if (component !== 'main') die('Los comandos de hosting administrado solo admiten main. Despliega este componente con tu proveedor y configura su SDK.');
  await apiCall(cfg, `/v1/projects/${projectId}/publish`, { method: 'POST' });
  log('✓ Publicado (prod).');
}

async function cmdRollback(sha?: string) {
  if (!sha) die('Falta --sha <sha>');
  const { cfg, projectId, component } = requireCtx();
  if (component !== 'main') die('Los comandos de hosting administrado solo admiten main. Despliega este componente con tu proveedor y configura su SDK.');
  await apiCall(cfg, `/v1/projects/${projectId}/rollback`, { method: 'POST', body: { sha } });
  log(`✓ Revertido a ${sha}.`);
}

async function cmdScan(file?: string, mode?: string, selectedComponent?: string) {
  const { cfg, projectId } = requireCtx();
  if (mode && mode !== 'everock' && mode !== 'foglamp') {
    die('--mode debe ser "everock" o "foglamp".');
  }
  const component = selectedComponent ?? readLink()?.component ?? 'main';
  const foglampMode = mode === 'foglamp';
  if (foglampMode && component !== 'main') die('El análisis comparativo solo admite main.');
  const scanFile = file ?? (foglampMode ? '.everock/foglamp-scan.json' : '.everock/codebase-scan.json');
  const full = resolve(process.cwd(), scanFile);
  if (!existsSync(full)) {
    die(
      `No existe ${scanFile}. Pega el prompt de Codebase en tu agente para que investigue el repositorio y genere el mapa.`,
    );
  }
  const size = statSync(full).size;
  if (size > 1024 * 1024) die('El scan excede 1 MB. Resume la arquitectura antes de publicarlo.');
  let scan: unknown;
  try {
    scan = JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    die(`${scanFile} no contiene JSON válido.`);
  }
  const value = scan as { version?: unknown; graph?: { nodes?: unknown; edges?: unknown } };
  if (value?.version !== 1 || !Array.isArray(value.graph?.nodes) || !Array.isArray(value.graph?.edges)) {
    die('El archivo no cumple el contrato de Codebase Scan.');
  }

  const endpoint = `/v1/projects/${projectId}/codebase-scan${foglampMode ? '/foglamp' : ''}?component=${encodeURIComponent(component)}`;
  const result = await apiCall<{ nodes: number; scannedAt: string }>(cfg, endpoint, {
    method: 'POST',
    body: scan,
  });
  log(`✓ ${foglampMode ? 'Comparación Foglamp' : 'Codebase'} publicada · ${result.nodes} nodos · ${new Date(result.scannedAt).toLocaleString('es-MX')}`);
}

// ─── entry ───
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: {type:'boolean'},
      'no-browser': {type:'boolean'},
      name: {type:'string'},
      'local-only': { type: 'boolean' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      'project-id': { type: 'string' },
      sha: { type: 'string' },
      file: { type: 'string' },
      mode: { type: 'string' },
      component: { type: 'string' },
      errors: { type: 'boolean' },
    },
  });
  const cmd = values.help?'help':positionals[0];
  switch (cmd) {
    case 'login':
      return cmdLogin(values['api-key'], values['api-url'],Boolean(values['no-browser']));
    case 'logout': return cmdLogout(Boolean(values['local-only']));
    case 'whoami': {const cfg=readConfig();if(!cfg)die('Run everock login first.');log(JSON.stringify(await apiCall(cfg!,'/v1/auth/session')));return;}
    case 'github': return cmdGithub(Boolean(values['no-browser']));
    case 'projects': return cmdProjects(positionals[1]==='create'?values.name:undefined);
    case 'init': return cmdInit(values.name,values['project-id'],values.component);
    case 'link':
      return cmdLink(values['project-id'], values.component, Boolean(values['local-only']));
    case 'dev':
      return cmdDev();
    case 'push':
      return cmdPush();
    case 'logs':
      return cmdLogs(Boolean(values.errors));
    case 'deploy':
      return cmdDeploy();
    case 'rollback':
      return cmdRollback(values.sha);
    case 'scan':
      return cmdScan(values.file, values.mode, values.component);
    default:
      log(
        [
          'Everock CLI',
          '',
          '  everock login [--api-url URL] [--no-browser]',
          '  everock logout [--local-only] | whoami',
          '  everock github connect',
          '  everock projects [create --name "My app"]',
          '  everock init --name "My app" [--component api]',
          '  everock link --project-id <uuid> [--component api] [--local-only]',
          '  everock dev        # watch + sync en caliente',
          '  everock push       # sync único',
          '  everock logs [--errors]',
          '  everock deploy',
          '  everock rollback --sha <sha>',
          '  everock scan       # valida y publica .everock/codebase-scan.json',
          '  everock scan --file .everock/codebase-scan.json',
          '  everock scan --mode foglamp --file .everock/foglamp-scan.json',
        ].join('\n'),
      );
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
