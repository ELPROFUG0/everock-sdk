import type {EventStore,StoredEvent} from './persistence.js';
/** One private database per collector/key/component. Opens only after analytics consent. */
export function browserEventStore(scope:string):EventStore{
 const database=Promise.resolve().then(()=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope))).then(hash=>new Promise<IDBDatabase>((resolve,reject)=>{
  const name='everock-pending-'+Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
  const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('events',{keyPath:'id'});request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('storage_blocked'));
 }));
 const transaction=async<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>|undefined)=>{
  const db=await database;return new Promise<T>((resolve,reject)=>{const tx=db.transaction('events',mode);let result:T;const req=action(tx.objectStore('events'));if(req)req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result!);tx.onerror=tx.onabort=()=>reject(tx.error);});
 };
 return {load:()=>transaction('readonly',store=>store.getAll()) as Promise<StoredEvent[]>,apply:async(put,remove)=>{await transaction('readwrite',store=>{for(const row of put)store.put(row);for(const id of remove)store.delete(id);return undefined;});},clear:async()=>{await transaction('readwrite',store=>store.clear());}};
}
