import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

type Result={content:{type:'text';text:string}[];isError?:boolean};
type ApiCall=<T>(path:string,init?:{method?:string;body?:unknown})=>Promise<T>;
type Wrap=(handler:(args:any)=>Promise<Result>)=>(args:any,extra?:any)=>Promise<Result>;
const slug=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48);
const directory=z.string().max(200).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>part==='.'||part==='..'));
const identity={projectId:z.string().uuid(),component:slug.describe('Registered application/component ID; use list_project_components first.')};
const ok=(data:unknown):Result=>({content:[{type:'text',text:JSON.stringify(data,null,2)}]});
type Component={slug:string;name:string;kind:string;repo:string|null;defaultBranch:string;workingDirectory:string;lastEventAt?:string|null};

export function registerComponentTools(server:McpServer,call:ApiCall,wrap:Wrap,apiUrl:string|(()=>string)){
 server.tool('create_project','Create an empty Everock project with SDK keys and a main application. List projects first to reuse an existing project. Keep requestId stable across retries.',{name:z.string().trim().min(1).max(48),requestId:z.string().uuid()},wrap(async(body)=>{const result=await call<any>('/v1/projects/setup',{method:'POST',body});const {secretOnce,...safe}=result;return ok(safe);}));
 server.tool('get_github_connection','Check the current user GitHub authorization. If absent, present authorizeUrl once; after authorization the agent can connect permitted repos without a dashboard visit.',{},wrap(async()=>ok(await call('/v1/auth/github'))));

 server.tool('create_project_component','Register a Web/API/worker application in an existing project after inspecting its local checkout. List components first and reuse the matching repository/directory. This does not install the SDK or grant GitHub access. Repeating the same component ID and configuration returns the existing application.',{
  ...identity,name:z.string().trim().min(1).max(80),kind:z.enum(['web','api','worker','mobile','other']),defaultBranch:z.string().min(1).max(200).default('main'),workingDirectory:directory.default(''),
 },wrap(async({projectId,component,...body})=>{
  const current=await call<{components:Component[]}>(`/v1/projects/${projectId}/components`);
  const existing=current.components.find(item=>item.slug===component);
  if(existing){if(existing.name!==body.name||existing.kind!==body.kind||existing.workingDirectory!==body.workingDirectory||existing.defaultBranch!==body.defaultBranch)throw new Error('component_exists_with_different_configuration: inspect the existing application or choose another ID.');return ok({component:existing,reused:true});}
  try{return ok(await call(`/v1/projects/${projectId}/components`,{method:'POST',body:{...body,slug:component}}));}
  catch(error){if(!(error instanceof Error)||!error.message.startsWith('409'))throw error;const latest=await call<{components:Component[]}>(`/v1/projects/${projectId}/components`);const found=latest.components.find(item=>item.slug===component);if(found&&found.name===body.name&&found.kind===body.kind&&found.workingDirectory===body.workingDirectory&&found.defaultBranch===body.defaultBranch)return ok({component:found,reused:true});throw error;}
 }));
 server.tool('list_component_repositories','List repositories already authorized through the GitHub App. This does not request new access.',{projectId:identity.projectId},wrap(async({projectId})=>ok(await call(`/v1/projects/${projectId}/component-repositories`))));
 server.tool('preview_component_repository','Detect application frameworks and monorepo folders using authorized repository metadata.',{projectId:identity.projectId,repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),installationId:z.number().int().positive()},wrap(async({projectId,repo,installationId})=>ok(await call(`/v1/projects/${projectId}/component-repository-preview?${new URLSearchParams({repo,installationId:String(installationId)})}`))));
 server.tool('connect_component_repository','Connect the actual GitHub integration for an application. Omit installationId to discover an existing authorized installation automatically. No dashboard visit is needed when access is already granted. If GitHub authorization is missing, return the authorization link; a login to Everock alone cannot grant new GitHub permissions.',{...identity,repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),installationId:z.number().int().positive().optional(),defaultBranch:z.string().min(1).max(200).optional(),workingDirectory:directory.optional()},wrap(async({projectId,component,...body})=>ok(await call(`/v1/projects/${projectId}/components/${component}/repository`,{method:'PATCH',body}))));
 server.tool('get_component_setup','Get public SDK configuration and verified repository/telemetry state for an application. Never returns the secret sourcemap upload key. Installing a dependency alone does not prove runtime connection.',identity,wrap(async({projectId,component})=>{
  const current=await call<{components:Component[]}>(`/v1/projects/${projectId}/components`),found=current.components.find(item=>item.slug===component);
  if(!found)throw new Error('unknown_component');
  const keys=await call<{publicKey:string}>(`/v1/projects/${projectId}/keys`);
  return ok({component:found,sdk:{publicKey:keys.publicKey,endpoint:typeof apiUrl==='function'?apiUrl():apiUrl,component,serviceName:found.name},releaseEnvironment:{EVEROCK_COMPONENT:component},runtimeGuidance:{javascript:"Use @everock/sdk with the runtime-specific adapter. Install browser instrumentation separately for sessions/replay.",python:"Use everock-sdk with the framework and HTTP-client extras. Until publication, install the built wheel. Map publicKey to public_key and serviceName to service_name.",verification:"Generate a real request and verify component, environment and release in received telemetry. Repository connection alone is not runtime verification."},telemetryVerified:!!found.lastEventAt});
 }));
 server.tool('get_component_connection_links','Get GitHub authorization and existing platform setup links. Open authorization URLs for the user; they must choose repositories and approve access. No connections are created by this tool. Deployment reporting is SDK/webhook based, not a provider OAuth connection.',identity,wrap(async({projectId,component})=>{
  const current=await call<{components:Component[]}>(`/v1/projects/${projectId}/components`);if(!current.components.some(item=>item.slug===component))throw new Error('unknown_component');
  const links=await call<Record<string,unknown>>(`/v1/projects/${projectId}/component-connections`);
  return ok({...links,sourcePath:`/panel/${projectId}?setup=${component}&step=source`});
 }));
 server.tool('link_component_checkout','Link the local checkout to an existing application using repository identity only. Run git locally to detect origin, branch and relative application directory. No source files are uploaded, no GitHub App is required, and no browser authorization is needed after Everock authentication. This does not authorize server access to GitHub contents.',{...identity,repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),defaultBranch:z.string().min(1).max(200),workingDirectory:directory.default(''),framework:z.string().min(1).max(80).optional(),detectedKind:z.enum(['web','api','worker','mobile','other']).optional()},wrap(async({projectId,component,...body})=>ok(await call(`/v1/projects/${projectId}/repository-identity`,{method:'POST',body:{...body,component}}))));
 server.tool('record_component_repository','Record repository identity and detected runtime from the local checkout. This does not grant GitHub access or mark a repository connected.',{...identity,repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),defaultBranch:z.string().min(1).max(200),framework:z.string().min(1).max(80).optional(),detectedKind:z.enum(['web','api','worker','mobile','other']).optional()},wrap(async({projectId,component,...body})=>ok(await call(`/v1/projects/${projectId}/repository-identity`,{method:'POST',body:{...body,component}}))));
 server.tool('publish_component_scan','Publish a high-level architecture summary for the selected application. Do not upload source code, secrets or personal data. The API validates the scan and keeps maps separate by component.',{...identity,scan:z.record(z.string(),z.unknown())},wrap(async({projectId,component,scan})=>ok(await call(`/v1/projects/${projectId}/codebase-scan?component=${component}`,{method:'POST',body:scan}))));
 server.tool('get_component_deployment_setup','Get release webhook URLs for this application when configuring its deployment reporting. Treat webhook URLs as credentials; write them only to the intended build/provider settings and do not include them in public logs.',identity,wrap(async({projectId,component})=>{
  const current=await call<{components:Component[]}>(`/v1/projects/${projectId}/components`);if(!current.components.some(item=>item.slug===component))throw new Error('unknown_component');
  const hook=await call<{url:string;vercel:string;cloudflare:string}>(`/v1/projects/${projectId}/deploy-hook`);
  const add=(value:string)=>{const url=new URL(value);url.searchParams.set('component',component);return url.toString();};
  return ok({url:add(hook.url),vercel:add(hook.vercel),cloudflare:add(hook.cloudflare),releaseEnvironment:{EVEROCK_COMPONENT:component},providerOAuthSupported:false});
 }));
}
