import type {Life} from './data'

interface FeatureIdentity {name:string;source_ref:string}
interface FeatureLifetime {lifecycle:Life;lifetime_seconds?:number|null}
const timestamp=(value?:string)=>{const parsed=value?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:undefined}

/** Duplicate branches keep an instance suffix that is unique among their actual names. */
export function featureSelectionLabel(instance:FeatureIdentity,choices:FeatureIdentity[]){
 const siblings=choices.filter(choice=>choice.source_ref===instance.source_ref&&choice.name!==instance.name)
 let hint:string|undefined
 if(siblings.length){
  let length=Math.min(8,instance.name.length)
  while(length<instance.name.length&&siblings.some(choice=>choice.name.endsWith(instance.name.slice(-length))))length++
  hint=length<instance.name.length?`…${instance.name.slice(-length)}`:instance.name
 }
 return {branch:instance.source_ref||instance.name,hint,tooltip:`${instance.source_ref||instance.name} · ${instance.name}`}
}

export function featureUptimeSeconds(instance:FeatureLifetime,now=Date.now()){
 const created=timestamp(instance.lifecycle.created_at),stopped=timestamp(instance.lifecycle.stopped_at)
 if(created!==undefined&&stopped!==undefined)return Math.max(0,(stopped-created)/1000)
 if(instance.lifetime_seconds===null)return undefined
 if(created!==undefined&&Number.isFinite(now))return Math.max(0,(now-created)/1000)
 return typeof instance.lifetime_seconds==='number'&&Number.isFinite(instance.lifetime_seconds)&&instance.lifetime_seconds>=0?instance.lifetime_seconds:undefined
}

/** A deadline is a schedule, not resource health or evidence that the feature stopped. */
export function featureSchedule(lifecycle:Life,now=Date.now(),inactive=false):{kind:'scheduled'|'overdue'|'stopped';at:number;seconds?:number}|undefined{
 const stopped=timestamp(lifecycle.stopped_at)
 if(stopped!==undefined)return {kind:'stopped',at:stopped}
 if(inactive)return undefined
 const planned=timestamp(lifecycle.auto_stop_at)
 if(planned===undefined||!Number.isFinite(now))return undefined
 return {kind:planned>now?'scheduled':'overdue',at:planned,seconds:Math.abs(planned-now)/1000}
}
