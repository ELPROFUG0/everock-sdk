import type { BrowserSettings } from '@everock/shared/browser-settings';
type Emit = (type: 'trace' | 'log', message: string, payload: Record<string, unknown>) => void;
/** Optional browser sensors. Every installed hook has a matching cleanup. */
export function startBrowserPlugins(plugins: BrowserSettings['plugins'], emit: Emit): () => void {
  const cleanups: (()=>void)[]=[];
  let active=true;
  if(plugins.logs) for(const level of ['debug','info','log','warn','error'] as const) {
    const original=console[level];
    const wrapped=(...args:unknown[])=>{
      original.apply(console,args);
      if(!active)return;
      const message=args.map(value=>typeof value==='string'?value:value instanceof Error?value.message:typeof value==='object'?'[object]':String(value)).join(' ').slice(0,2000);
      emit('log',message,{kind:'console',level});
    };
    console[level]=wrapped;
    cleanups.push(()=>{if(console[level]===wrapped)console[level]=original;});
  }
  if(plugins.pageEvents) {
    const page=()=>{if(active)emit('trace','Page view',{kind:'page_view',path:location.pathname});};
    page();
    for(const method of ['pushState','replaceState'] as const) {
      const original=history[method];
      const wrapped:History[typeof method]=function(...args){original.apply(history,args);page();};
      history[method]=wrapped;
      cleanups.push(()=>{if(history[method]===wrapped)history[method]=original;});
    }
    window.addEventListener('popstate',page);cleanups.push(()=>window.removeEventListener('popstate',page));
  }
  if(plugins.rageClick) {
    let last:EventTarget|null=null, at=0, x=0, y=0, clicks=0;
    const click=(event:MouseEvent)=>{
      if(!active)return;
      const now=Date.now();
      clicks=event.target===last&&now-at<1000&&Math.hypot(event.clientX-x,event.clientY-y)<25?clicks+1:1;
      last=event.target;at=now;x=event.clientX;y=event.clientY;
      if(clicks===3){emit('trace','Rage click',{kind:'rage_click',path:location.pathname,tag:event.target instanceof Element?event.target.tagName.toLowerCase():null,clicks});clicks=0;}
    };
    const options={capture:true};
    document.addEventListener('click',click,options);cleanups.push(()=>document.removeEventListener('click',click,options));
  }
  return ()=>{if(!active)return;active=false;cleanups.reverse().forEach(stop=>stop());};
}
