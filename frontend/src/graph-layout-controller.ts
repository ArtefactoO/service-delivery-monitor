import type {GraphGeometry} from './graph-layout'

export interface LayoutWorker {
 onmessage:((event:MessageEvent<{geometry?:GraphGeometry;failed?:boolean}>)=>void)|null
 onerror:((event:ErrorEvent)=>void)|null
 postMessage:(message:{structure:string})=>void
 terminate:()=>void
}

/** Cancelled/failed workers cannot publish stale geometry or block the UI as a fallback. */
export function requestGraphLayout(structure:string,create:()=>LayoutWorker,done:(geometry:GraphGeometry)=>void,failed:()=>void){
 let active=true,worker:LayoutWorker|undefined
 const finish=(geometry?:GraphGeometry)=>{
  if(!active)return
  active=false;worker?.terminate()
  if(geometry)done(geometry);else failed()
 }
 try{
  worker=create()
  worker.onmessage=event=>finish(event.data.failed?undefined:event.data.geometry)
  worker.onerror=()=>finish()
  worker.postMessage({structure})
 }catch{finish()}
 return()=>{active=false;worker?.terminate()}
}
