#!/usr/bin/env node
import {detectFramework} from './detect-framework.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync, realpathSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pollDeviceToken } from './device-poll.js';

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
  if (!cfg?.apiKey) die('No has iniciado sesión. Corre:  everock login');
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
  const base=(apiUrl??process.env.EVEROCK_API_URL??readConfig()?.apiUrl??(apiKey ? 'http://localhost:4000' : 'https://api.everock.dev')).replace(/\/$/,'');
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
  if (!cfg?.apiKey) die('Inicia sesión primero:  everock login');
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
      'api-key-stdin': { type: 'boolean' },
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
      if (values['api-key-stdin']) {
        if (values['api-key'] !== undefined || process.stdin.isTTY) {
          die('Pipe one API key to --api-key-stdin, or run everock login for browser sign-in.');
        }
        let key = '';
        for await (const chunk of process.stdin) {
          key += chunk.toString();
          if (key.length > 512) die('Invalid API key on stdin.');
        }
        key = key.trim();
        if (!/^ak_[A-Za-z0-9_-]{43}$/.test(key)) die('Invalid API key on stdin.');
        return cmdLogin(key, values['api-url']);
      }
      return cmdLogin(values['api-key'], values['api-url'],Boolean(values['no-browser']));
    case 'logout': return cmdLogout(Boolean(values['local-only']));
    case 'whoami': {const cfg=readConfig();if(!cfg)die('Run everock login first.');log(JSON.stringify(await apiCall(cfg!,'/v1/auth/session')));return;}
    case 'github': return cmdGithub(Boolean(values['no-browser']));
    case 'projects': return cmdProjects(positionals[1]==='create'?values.name:undefined);
    case 'init': return cmdInit(values.name,values['project-id'],values.component);
    case 'link':
      return cmdLink(values['project-id'], values.component, Boolean(values['local-only']));
    case 'logs':
      return cmdLogs(Boolean(values.errors));
    case 'scan':
      return cmdScan(values.file, values.mode, values.component);
    default:
      if (cmd && cmd !== 'help') die('Unknown command. Run everock --help.');
      log(
        [
          'Everock CLI',
          '',
          '  everock login [--api-url URL] [--no-browser]',
          '  everock login --api-key-stdin --api-url URL',
          '  everock logout [--local-only] | whoami',
          '  everock github connect',
          '  everock projects [create --name "My app"]',
          '  everock init --name "My app" [--component api]',
          '  everock link --project-id <uuid> [--component api] [--local-only]',
          '  everock logs [--errors]',
          '  everock scan       # valida y publica .everock/codebase-scan.json',
          '  everock scan --file .everock/codebase-scan.json',
          '  everock scan --mode foglamp --file .everock/foglamp-scan.json',
        ].join('\n'),
      );
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
