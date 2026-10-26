import {layoutResourceGraph} from './graph-layout'
import type {LayoutWorker} from './graph-layout-controller'

const channel=self as unknown as {onmessage:(event:MessageEvent<{structure:string}>)=>void;postMessage:(message:Parameters<NonNullable<LayoutWorker['onmessage']>>[0]['data'])=>void}
channel.onmessage=event=>{
 try{
  const input=JSON.parse(event.data.structure)
  channel.postMessage({geometry:layoutResourceGraph(input.resources,input.relationships,input.components)})
 }catch{channel.postMessage({failed:true})}
}
