/** HTTP identity only: never record credentials, query strings, headers or bodies. */
export function requestMeasurement(url:string,method:string,statusCode:number,durationMs:number,options:{route?:string;direction?:'inbound'|'outbound';host?:string}={}){
 let parsed:URL;try{parsed=new URL(url,'http://runtime.local');}catch{return null;}
 const path=(typeof options.route==='string'?options.route:parsed.pathname).split('?')[0]!.split('#')[0]!
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,':id')
  .replace(/\/[^/]*@[^/]*(?=\/|$)/g,'/:id')
  .replace(/\/\d+(?=\/|$)/g,'/:id').replace(/\/[0-9a-f]{24,}(?=\/|$)/gi,'/:id').slice(0,300);
 return {kind:'http' as const,method:(typeof method==='string'?method:'GET').toUpperCase().slice(0,12),path,host:(typeof options.host==='string'?options.host:parsed.host).slice(0,253),statusCode,failed:statusCode===0||statusCode>=400,durationMs:Math.max(0,Math.min(3600000,Math.round(durationMs*100)/100)),direction:options.direction??'inbound'};
}

export function isTelemetryRequest(raw: string, base: string, endpoint: string): boolean {
  try {
    const request = new URL(raw, base);
    const ingest = new URL(`${endpoint.replace(/\/$/, '')}/ingest`);
    return request.origin === ingest.origin && (request.pathname === ingest.pathname || request.pathname.startsWith(`${ingest.pathname}/`) || request.pathname === new URL(`${endpoint.replace(/\/$/, '')}/sdk/config`).pathname);
  } catch { return false; }
}
