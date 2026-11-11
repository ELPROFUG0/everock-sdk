import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

type Result = {content: {type:'text';text:string}[];isError?:boolean};
type ApiCall = <T>(path:string, init?:{method?:string;body?:unknown})=>Promise<T>;
type Wrap = (handler:(args:any)=>Promise<Result>)=>(args:any,extra?:any)=>Promise<Result>;
const projectId = z.string().uuid();
const detection = z.object({
  windowMinutes:z.number().int().min(1).max(60).default(5),
  minOccurrences:z.number().int().min(2).max(1000).default(5),
  minContexts:z.number().int().min(1).max(100).default(2),
  serverOccurrences:z.number().int().min(2).max(1000).default(10),
  minRequests:z.number().int().min(0).max(100000).default(0),
  errorRatePercent:z.number().min(0).max(100).default(0),
});
const monitor = z.object({
  enabled:z.boolean().default(true),
  failureThreshold:z.number().int().min(1).max(20).default(3),
  recoveryThreshold:z.number().int().min(1).max(20).default(2),
  latencyWarningMs:z.number().int().min(50).max(60000).nullable().default(null),
});
const result = (data:unknown):Result => ({content:[{type:'text',text:JSON.stringify(data,null,2)}]});
type Watcher = {detectionPolicy?:unknown};
type Service = {id:string;name:string;source:string;checkEnabled:boolean;checkIntervalSeconds:number;alertPolicy?:unknown};
const policy = (raw:unknown) => detection.parse(raw??{});
const safeMonitor = (service:Service) => ({serviceId:service.id,name:service.name,editable:service.source==='manual',checksEnabled:service.checkEnabled,checkEverySeconds:service.checkIntervalSeconds,alertPolicy:monitor.parse(service.alertPolicy??{})});

/** Narrow tools deliberately exclude notification destinations, secrets and schedule mutations. */
export function registerAlertTools(server:McpServer, call:ApiCall, wrap:Wrap) {
  server.tool('get_detection_settings','Read the advanced problem-detection settings shown in Settings. Owner access required. Defaults group repeated errors; crashes are immediate. No handoff secrets or notification destinations are returned.',{projectId},wrap(async({projectId})=>{
    const current=await call<Watcher>(`/v1/projects/${projectId}/watcher`);
    return result({projectId,detectionPolicy:policy(current.detectionPolicy),recommended:detection.parse({})});
  }));
  server.tool('update_detection_settings','Change advanced problem-detection settings for the project owner. Read current settings first; changes contains only fields requested by the user and preserves the rest. minRequests/errorRatePercent=0 disables that gate. Does not disable detection or change agent/notification configuration.',{projectId,changes:detection.partial().strict().refine(value=>Object.keys(value).length>0,'Provide at least one setting.')},wrap(async({projectId,changes})=>{
    const current=await call<Watcher>(`/v1/projects/${projectId}/watcher`);
    const next=detection.parse({...policy(current.detectionPolicy),...changes});
    const saved=await call<Watcher>(`/v1/projects/${projectId}/watcher`,{method:'PATCH',body:{detectionPolicy:next}});
    return result({projectId,detectionPolicy:policy(saved.detectionPolicy)});
  }));
  server.tool('reset_detection_settings','Restore recommended advanced problem-detection thresholds. Does not change monitoring schedules, agent handoffs or notification configuration.',{projectId},wrap(async({projectId})=>{
    const saved=await call<Watcher>(`/v1/projects/${projectId}/watcher`,{method:'PATCH',body:{detectionPolicy:detection.parse({})}});
    return result({projectId,detectionPolicy:policy(saved.detectionPolicy)});
  }));
  server.tool('list_monitor_alert_settings','Read existing service and endpoint monitor alert settings. Auto-discovered services are passive and cannot be changed by update_monitor_alert_settings. Never returns health URLs or credentials.',{projectId},wrap(async({projectId})=>{
    const current=await call<{services:Service[]}>(`/v1/projects/${projectId}/services`);
    return result({projectId,monitors:current.services.map(safeMonitor)});
  }));
  server.tool('update_monitor_alert_settings','Change advanced alert settings of an existing manual service/endpoint monitor. List monitors first. enabled controls Inbox reports, not scheduled HTTP requests. latencyWarningMs=null disables slow-response warnings. Preserves URL, schedule and unrelated preferences. Updating rules resets check streaks.',{projectId,serviceId:z.string().uuid(),changes:monitor.partial().strict().refine(value=>Object.keys(value).length>0,'Provide at least one setting.')},wrap(async({projectId,serviceId,changes})=>{
    const current=await call<{services:Service[]}>(`/v1/projects/${projectId}/services`);
    const service=current.services.find(item=>item.id===serviceId);
    if(!service||service.source!=='manual')throw new Error('Manual monitor not found in this project.');
    const alertPolicy=monitor.parse({...monitor.parse(service.alertPolicy??{}),...changes});
    const saved=await call<{service:Service}>(`/v1/projects/${projectId}/services/${serviceId}`,{method:'PATCH',body:{alertPolicy}});
    return result({projectId,monitor:safeMonitor(saved.service)});
  }));
}
