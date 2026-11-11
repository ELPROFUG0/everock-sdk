import {bytes} from './transport.js';
export interface StoredEvent {id:string;at:number;event:any;}
/** Optional adapter for runtimes such as Durable Objects. Never store unredacted input. */
export interface EventStore {load():Promise<StoredEvent[]>;apply(put:StoredEvent[],remove:string[]):Promise<void>;clear():Promise<void>;}
export interface PersistenceOptions {maxEvents?:number;maxBytes?:number;maxAgeMs?:number;}
const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>Number.isFinite(value)?Math.min(max,Math.max(min,Math.floor(value!))):fallback;
export class DurableQueue {
 private maxEvents:number;private maxBytes:number;private maxAgeMs:number;
 private syncScheduled=false;
 private expiredIds=new Set<string>();private known=new Set<string>();private records=new Map<string,StoredEvent>();private puts=new Map<string,StoredEvent>();private removes=new Set<string>();private running:Promise<void>|null=null;private size=0;private stopped=false;
 readonly diagnostics={persisted:0,recovered:0,storageErrors:0,droppedCapacity:0,droppedExpired:0,discardedRejected:0,discardedPrivacy:0};
 recover(){for(const row of this.records.values())if(row.at<Date.now()-this.maxAgeMs){this.remove(row.id);this.expiredIds.add(row.id);this.diagnostics.droppedExpired++;}return [...this.records.values()].map(row=>row.event);}
 drainExpired(){const ids=this.expiredIds;this.expiredIds=new Set();return ids;}
 discardWhere(predicate:(event:any)=>boolean){for(const row of this.records.values())if(predicate(row.event)){this.remove(row.id);this.diagnostics.discardedPrivacy++;}void this.sync();}
 readonly ready:Promise<void>;
 constructor(private store:EventStore,options:PersistenceOptions={},runtime:'node'|'portable'='portable'){
  const server = runtime === 'node';
  this.maxEvents=bounded(options.maxEvents,server?10000:1000,1,server?20000:2000);
  this.maxBytes=bounded(options.maxBytes,server?24000000:5000000,48000,server?48000000:10000000);
  this.maxAgeMs=bounded(options.maxAgeMs,86400000,60000,86400000);
  this.ready=store.load().then(rows=>{
   // Apply the capacity policy oldest first, including captures made during storage startup.
   const fresh = [...this.records.values()];
   this.records.clear();this.puts.clear();this.size=0;
   for(const row of rows.sort((a,b)=>a.at-b.at)){
    this.known.add(row.id);
    this.add(row, false);
   }
   for(const row of fresh)this.add(row);
   for(const id of this.records.keys())if(this.known.has(id))this.diagnostics.recovered++;
  }).catch(()=>{this.diagnostics.storageErrors++;});
 }
 private add(row:StoredEvent, needsWrite=true){
  if(this.stopped)return;
  if(row.at<Date.now()-this.maxAgeMs){this.diagnostics.droppedExpired++;this.removes.add(row.id);return;}
  const length=bytes(JSON.stringify(row));if(this.records.has(row.id))return;
  this.removes.delete(row.id);this.records.set(row.id,row);this.size+=length;if(needsWrite)this.puts.set(row.id,row);
  while(this.records.size>this.maxEvents||this.size>this.maxBytes){
   const first=this.records.values().next().value!;this.remove(first.id);this.diagnostics.droppedCapacity++;
  }
 }
 put(event:any){if(!event.id||this.stopped)return;this.add({id:event.id,at:Date.now(),event});
  if(this.syncScheduled)return;
  this.syncScheduled=true;
  void this.ready.then(()=>{this.syncScheduled=false;return this.sync();});
 }
 private remove(id:string){const row=this.records.get(id);if(row)this.size-=bytes(JSON.stringify(row));this.records.delete(id);this.puts.delete(id);if(this.known.has(id))this.removes.add(id);}
 ack(events:any[],rejected=false){for(const event of events){this.remove(event.id);if(rejected)this.diagnostics.discardedRejected++;}void this.sync();}
 async sync():Promise<void>{
  await this.ready;if(this.running)return this.running;
  const run=async()=>{while(this.puts.size||this.removes.size){const put=[...this.puts.values()],remove=[...this.removes];this.puts.clear();this.removes.clear();try{for(const row of put)this.known.add(row.id);await this.store.apply(put,remove);for(const id of remove)this.known.delete(id);this.diagnostics.persisted+=put.length;}catch{this.diagnostics.storageErrors++;for(const row of put)if(this.records.has(row.id)&&!this.removes.has(row.id))this.puts.set(row.id,row);for(const id of remove)if(!this.records.has(id))this.removes.add(id);break;}}};
  const pending=run().finally(()=>{if(this.running===pending)this.running=null;});this.running=pending;return pending;
 }
 async clear(){this.stopped=true;await this.ready;await this.sync();this.diagnostics.discardedPrivacy+=this.records.size;this.records.clear();this.known.clear();this.puts.clear();this.removes.clear();this.size=0;try{await this.store.clear();}catch{this.diagnostics.storageErrors++;}}
 getDiagnostics(){return {...this.diagnostics,pendingDurableEvents:this.records.size,pendingDurableBytes:this.size,pendingPersistenceChanges:this.puts.size+this.removes.size};}
}
