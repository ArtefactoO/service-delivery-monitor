import {safeUrl,type EventRecord,type DeliveryPayload,type ArgoNotificationPayload,type Links,type Service,type Tone} from './data.ts'
export interface HistoryTiming {kind:string;label:string;startedAt?:number;finishedAt?:number;durationSeconds?:number;terminalEventId?:number}
export interface HistoryOperation {id:string;service:string;kind:'build'|'delivery'|'argo';title:string;tone:Tone;status:string;at:number;environment?:string;instance?:string;ref:string;events:EventRecord[];timings?:HistoryTiming[];startedAt?:number;finishedAt?:number;durationSeconds?:number;technical?:boolean}
export function scopeHistory(items:EventRecord[],environment?:string,instance?:string,ref?:string,historyRef?:string){
 if(historyRef)return items.filter(item=>'event'in item.payload?item.payload.source_ref===historyRef:item.payload.source.ref===historyRef)
 if(!environment)return items
 return items.filter(item=>{
  const p=item.payload
  if('event'in p)return p.environment===environment&&(!instance||p.application===instance)
  if(item.kind==='build')return ref?p.source.ref===ref:environment==='feature'?p.source.ref.startsWith('feature/'):!p.source.ref.startsWith('feature/')
  return p.target?.environment===environment&&(!instance||p.target.instance===instance)
 })
}
const statusName=(status:string)=>status==='succeeded'?'Успешно':status==='failed'?'Ошибка':status==='canceled'?'Отменено':'Выполняется'
const statusTone=(status:string):Tone=>status==='succeeded'?'ok':status==='failed'?'danger':status==='canceled'?'muted':'warn'
const parsed=(value:string|undefined,fallback:number)=>{const time=Date.parse(value||'');return Number.isFinite(time)?time:fallback}
export function eventTime(item:EventRecord){
 const p=item.payload,fallback=item.received_at*1000
 if(!('event'in p))return parsed(p.occurred_at,fallback)
 return parsed(p.event==='health_changed'?p.health_changed_at:p.event==='created'?undefined:p.event==='deleting'?p.deletion_started_at:p.event==='sync_running'?p.operation_started_at:p.operation_finished_at,fallback)
}
export function hasEventTime(item:EventRecord){
 const p=item.payload
 const value=!('event'in p)?p.occurred_at:p.event==='health_changed'?p.health_changed_at:p.event==='created'?undefined:p.event==='deleting'?p.deletion_started_at:p.event==='sync_running'?p.operation_started_at:p.operation_finished_at
 return Number.isFinite(parsed(value,NaN))
}
const attemptKey=(item:EventRecord)=>{
 const p=item.payload as DeliveryPayload
 return [item.service,p.attempt.project_id||'',p.attempt.pipeline_id,p.attempt.job_id,p.source.ref,p.source.revision,p.action||'upsert',p.target?.environment||'',p.target?.instance||'']
}
const timingLabel=(kind:string)=>kind==='build'?'Build':kind==='publication'?'Publication':kind==='deployment'?'Deploy verification':'Argo sync'
/** Durations require source timestamps from one stage and one attempt, never receipt times. */
export function historyTimings(items:EventRecord[]):HistoryTiming[]{
 const groups=new Map<string,EventRecord[]>()
 for(const item of items){
  const p=item.payload
  const key='event'in p?p.event.startsWith('sync_')&&p.operation_started_at?JSON.stringify(['argo',p.source,p.project,p.application_uid,p.environment,p.source_ref,p.operation_started_at]):undefined:JSON.stringify([item.kind,...attemptKey(item)])
  if(key)groups.set(key,[...(groups.get(key)||[]),item])
 }
 const result:HistoryTiming[]=[]
 for(const group of groups.values()){
  const first=group[0],native='event'in first.payload
  if(native){
   const terminal=group.filter(item=>['sync_succeeded','sync_failed'].includes((item.payload as ArgoNotificationPayload).event)).sort((a,b)=>eventTime(a)-eventTime(b)||a.id-b.id).at(-1)
   const p=(terminal||first).payload as ArgoNotificationPayload,start=parsed(p.operation_started_at,NaN),end=terminal?parsed(p.operation_finished_at,NaN):NaN
   result.push({kind:'argocd',label:timingLabel('argocd'),startedAt:Number.isFinite(start)?start:undefined,finishedAt:Number.isFinite(end)?end:undefined,terminalEventId:terminal?.id,...(Number.isFinite(start)&&Number.isFinite(end)&&end>=start?{durationSeconds:(end-start)/1000}:{})})
  }else{
   const starts=group.filter(item=>(item.payload as DeliveryPayload).status==='started').map(item=>parsed((item.payload as DeliveryPayload).occurred_at,NaN)).filter(Number.isFinite)
   const terminal=group.filter(item=>(item.payload as DeliveryPayload).status!=='started').sort((a,b)=>eventTime(a)-eventTime(b)||a.id-b.id).at(-1)
   const start=starts.length?Math.min(...starts):NaN,end=terminal?parsed((terminal.payload as DeliveryPayload).occurred_at,NaN):NaN
   result.push({kind:first.kind,label:timingLabel(first.kind),startedAt:Number.isFinite(start)?start:undefined,finishedAt:Number.isFinite(end)?end:undefined,terminalEventId:terminal?.id,...(Number.isFinite(start)&&Number.isFinite(end)&&end>=start?{durationSeconds:(end-start)/1000}:{})})
  }
 }
 return result
}
export function formatDuration(seconds:number){
 if(seconds>0&&seconds<1)return `${Math.round(seconds*1000)}ms`
 const whole=Math.max(0,Math.floor(seconds))
 return [[Math.floor(whole/86400),'d'],[Math.floor(whole%86400/3600),'h'],[Math.floor(whole%3600/60),'m'],[whole%60,'s']].filter(([value])=>value).map(([value,unit])=>`${value}${unit}`).join(' ')||'0s'
}
export function eventLabel(item:EventRecord):string{
 const p=item.payload
 if('event'in p)return p.event==='sync_running'?'Argo: синхронизация началась':p.event==='sync_succeeded'?'Argo: синхронизация завершена':p.event==='sync_failed'?'Argo: ошибка синхронизации':p.event==='created'?'Argo: приложение обнаружено':p.event==='deleting'?'Argo: удаление приложения начато':`Argo: состояние ${p.health}`
 if(item.kind==='argocd')return 'Argo: обновление приложения'
 if(p.action==='delete')return p.status==='succeeded'?(item.kind==='publication'?'Удаление feature опубликовано':'Feature-окружение удалено'):p.status==='failed'?'Ошибка удаления feature':p.status==='canceled'?'Удаление feature отменено':'Удаление feature началось'
 if(item.kind==='build')return p.status==='succeeded'?'Образ готов':p.status==='failed'?'Ошибка сборки':p.status==='canceled'?'Сборка отменена':'Сборка образа'
 if(item.kind==='publication')return p.status==='succeeded'?'Конфигурация опубликована':p.status==='failed'?'Ошибка публикации':p.status==='canceled'?'Публикация отменена':'Подготовка публикации'
 return p.status==='succeeded'?(p.action==='delete'?'Feature-окружение удалено':'Выкат подтвержден'):p.status==='failed'?'Выкат не подтвержден':p.status==='canceled'?'Проверка выката отменена':'Проверка выката'
}
const ci=(item:EventRecord)=>!('event'in item.payload)
export function buildHistory(items:EventRecord[]){
 const groups=new Map<string,EventRecord[]>(),native:EventRecord[]=[]
 for(const item of items){
  const p=item.payload
  if('event'in p){native.push(item);continue}
  const key=JSON.stringify([item.kind==='build'?'build':item.kind==='argocd'?'argo':'delivery',...attemptKey(item)])
  groups.set(key,[...(groups.get(key)||[]),item])
 }
 const operations:HistoryOperation[]=[]
 for(const [id,events]of groups){
  const sorted=[...events].sort((a,b)=>eventTime(a)-eventTime(b)||a.id-b.id)
  const candidates=events.filter(e=>e.kind==='deployment'),stage=candidates.length?candidates:events
  const chosen=[...stage].sort((a,b)=>Number((a.payload as DeliveryPayload).status!=='started')-Number((b.payload as DeliveryPayload).status!=='started')||eventTime(a)-eventTime(b)).at(-1)!
  const p=chosen.payload as DeliveryPayload
  operations.push({id,service:chosen.service,kind:chosen.kind==='build'?'build':chosen.kind==='argocd'?'argo':'delivery',title:eventLabel(chosen),tone:statusTone(p.status),status:statusName(p.status),at:Math.max(...sorted.map(eventTime)),environment:p.target?.environment,instance:p.target?.instance,ref:p.source.ref,events:sorted})
 }
 const argoGroups=new Map<string,EventRecord[]>(),incidents=new Set<string>(),technical:EventRecord[]=[]
 for(const item of [...native].sort((a,b)=>eventTime(a)-eventTime(b)||a.id-b.id)){
  const p=item.payload as ArgoNotificationPayload,key=`${p.source}:${p.application_uid}`
  if(p.event.startsWith('sync_')){
   const id=JSON.stringify(['argo',key,p.project,p.environment,p.source_ref,p.operation_started_at||item.id])
   argoGroups.set(id,[...(argoGroups.get(id)||[]),item]);continue
  }
  if(p.event==='health_changed'){
   const bad=['Degraded','Missing','Unknown'].includes(p.health),recovery=p.health==='Healthy'&&
    (Object.hasOwn(item,'previous_health')?['Degraded','Missing','Unknown'].includes(item.previous_health||''):incidents.has(key))
   if(bad)incidents.add(key)
   if(p.health==='Healthy')incidents.delete(key)
   if(bad||recovery){operations.push({id:`argo:${item.id}`,kind:'argo',service:item.service,title:recovery?'Приложение восстановилось':`Argo: состояние ${p.health}`,tone:p.health==='Healthy'?'ok':p.health==='Unknown'?'warn':'danger',status:p.health,at:eventTime(item),environment:p.environment,instance:p.application,ref:p.source_ref,events:[item]});continue}
  }
  if(p.event==='deleting'){operations.push({id:`argo:${item.id}`,kind:'argo',service:item.service,title:eventLabel(item),tone:'warn',status:'Выполняется',at:eventTime(item),environment:p.environment,instance:p.application,ref:p.source_ref,events:[item]});continue}
  technical.push(item)
 }
 for(const [id,events]of argoGroups){
  // Correlate the whole sync only when exactly one CI attempt explains every
  // receipt. Neither input order nor partial lifecycle evidence may pick a job.
  const matches=operations.filter(operation=>operation.kind==='delivery'&&events.every(item=>{
   const p=item.payload as ArgoNotificationPayload
   if(p.event==='sync_failed'||operation.service!==item.service||operation.environment!==p.environment||operation.ref!==p.source_ref)return false
   const first=operation.events[0].payload as DeliveryPayload
   const terminal=operation.events.find(e=>e.kind==='deployment'&&ci(e)&&(e.payload as DeliveryPayload).status!=='started')
   if(!terminal||first.target?.instance!==p.application)return false
   const end=terminal.payload as DeliveryPayload
   if(end.runtime?.application_uid!==p.application_uid)return false
   const revisions=operation.events.flatMap(e=>ci(e)?[(e.payload as DeliveryPayload).publication?.revision].filter(Boolean):[])
   const started=parsed(p.operation_started_at,NaN),attemptStart=Math.min(...operation.events.map(eventTime))
   return p.revisions?.some(r=>revisions.includes(r))&&started>=attemptStart&&eventTime(item)>=started&&eventTime(item)<=parsed(end.runtime?.verified_at,eventTime(terminal))
  }))
  if(matches.length===1){matches[0].events.push(...events);continue}
  const chosen=[...events].sort((a,b)=>Number((a.payload as ArgoNotificationPayload).event!=='sync_running')-Number((b.payload as ArgoNotificationPayload).event!=='sync_running')||eventTime(a)-eventTime(b)).at(-1)!,p=chosen.payload as ArgoNotificationPayload
  const state=p.event==='sync_failed'?'failed':p.event==='sync_succeeded'?'succeeded':'started'
  operations.push({id,kind:'argo',service:chosen.service,title:state==='failed'?'Ошибка синхронизации Argo':state==='succeeded'?'Argo синхронизировал приложение':'Argo синхронизирует приложение',tone:statusTone(state),status:statusName(state),at:eventTime(chosen),environment:p.environment,instance:p.application,ref:p.source_ref,events})
 }
 for(const operation of operations){
  operation.events.sort((a,b)=>eventTime(a)-eventTime(b)||a.id-b.id)
  operation.timings=historyTimings(operation.events)
  const stages=operation.events.some(ci)?operation.timings.filter(timing=>timing.kind!=='argocd'):operation.timings
  if(stages.length&&stages.every(timing=>timing.durationSeconds!==undefined)){
   operation.startedAt=Math.min(...stages.map(timing=>timing.startedAt!))
   operation.finishedAt=Math.max(...stages.map(timing=>timing.finishedAt!))
   operation.durationSeconds=(operation.finishedAt-operation.startedAt)/1000
  }
 }
 return{operations:operations.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)),technical:technical.sort((a,b)=>eventTime(b)-eventTime(a))}
}
export function historyLinks(item:EventRecord,services:Service[],links:Links){
 const p=item.payload
 if(item.kind==='argocd')return[]
 if('event'in p){const base=safeUrl(links.argo[p.source])?.replace(/\/$/,'');return base?[{label:'Argo Application',url:`${base}/applications/argocd/${encodeURIComponent(p.application)}`}]:[]}
 const service=services.find(s=>s.key===item.service)
 const raw=item.kind==='build'?(links.gitlab&&service?`${links.gitlab}/${service.project}`:undefined):links.deployments?.replace(/\.git$/,'')
 const base=safeUrl(raw)?.replace(/\/$/,'')
 if(!base||item.kind==='build'&&p.attempt.project_id&&p.attempt.project_id!==service?.project_id)return[]
 return[{label:`Job #${p.attempt.job_id}`,url:`${base}/-/jobs/${p.attempt.job_id}`},{label:`Pipeline #${p.attempt.pipeline_id}`,url:`${base}/-/pipelines/${p.attempt.pipeline_id}`}]
}
