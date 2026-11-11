import {mkdir,readFile,readdir,open,rename,unlink,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {EventStore,StoredEvent} from './persistence.js';
/** Private, per-event atomic journal. IDs are shared across processes and server retries deduplicate them. */
export function nodeEventStore(scope:string,directory=join(homedir(),'.local','state','everock','sdk')):EventStore{
 const root=join(directory,createHash('sha256').update(scope).digest('hex'));
 const valid=(id:string)=>/^[0-9a-f-]{36}$/i.test(id);
 const ensure=async()=>{await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);};
 return {
  async load(){await ensure();const rows:StoredEvent[]=[];const files=await readdir(root);for(const file of files){if(!file.endsWith('.json'))continue;try{const value=await readFile(join(root,file),'utf8');if(value.length>50000)throw new Error('oversize');const row=JSON.parse(value);if(!valid(row.id)||!Number.isFinite(row.at)||row.at<Date.now()-86400000){await unlink(join(root,file));continue;}rows.push(row);}catch{await unlink(join(root,file)).catch(()=>{});}}return rows.sort((a,b)=>a.at-b.at);},
  async apply(put,remove){await ensure();for(let offset=0;offset<put.length;offset+=16)await Promise.all(put.slice(offset,offset+16).map(async row=>{if(!valid(row.id))return;const target=join(root,`${row.id}.json`),temp=join(root,`${row.id}.${randomUUID()}.tmp`);const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}try{await rename(temp,target);}finally{await unlink(temp).catch(()=>{});}}));for(const id of remove)if(valid(id))await unlink(join(root,`${id}.json`)).catch(error=>{if(error.code!=='ENOENT')throw error;});const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}},
  async clear(){await ensure();for(const file of await readdir(root))if(file.endsWith('.json')||file.endsWith('.tmp'))await unlink(join(root,file)).catch(()=>{});},
 };
}
