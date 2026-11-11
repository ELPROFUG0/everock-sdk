/** Identifiers, not authentication tokens; works on an HTTP LAN origin too. */
export function eventId():string{
 if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const data=new Uint8Array(16);
 if(typeof crypto!=='undefined'&&typeof crypto.getRandomValues==='function')crypto.getRandomValues(data);
 else for(let i=0;i<data.length;i++)data[i]=Math.floor(Math.random()*256);
 data[6]=(data[6]!&15)|64;data[8]=(data[8]!&63)|128;
 const hex=Array.from(data,n=>n.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
