import { Archive, ArrowRight, ChevronDown, Clock3, GitBranch } from 'lucide-react'
import { Button } from '@mui/material'
import { InfoTooltip } from '@project/ui/mui'
import { SystemIcon } from './SystemBadge'
import { LinkedValue } from './ServiceOverview'
import { buildHistory,eventLabel,eventTime,formatDuration,hasEventTime,historyLinks,historyTimings,scopeHistory,type HistoryOperation } from './history-data'
import {latest,observationMatchesLifecycle,type EventRecord,type Instance,type Links,type Service} from './data'
import {serviceHistoryHref} from './activity-context'
import './history.css'
const format=new Intl.DateTimeFormat('ru-RU',{year:'numeric',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
function ExactTime({value,received=false}:{value:number;received?:boolean}){
 const iso=new Date(value).toISOString()
 return <time dateTime={iso} title={`${received?'Время получения SDM':'Время события'}: ${iso}`}>{format.format(value)}{received&&<span className="history-received-time"> · получено</span>}</time>
}
function EventDetails({items}:{items:EventRecord[]}){
 const timings=historyTimings(items)
 return <ol className="history-steps">{items.map(item=>{const timing=timings.find(value=>value.terminalEventId===item.id&&value.durationSeconds!==undefined);return <li key={item.id}><ExactTime value={eventTime(item)} received={!hasEventTime(item)}/><span className="history-step-body">{eventLabel(item)}{'event'in item.payload?<small>{item.service} · {item.payload.environment} · {item.payload.application}</small>:item.payload.failure_code&&<small>{item.payload.failure_code}</small>}{timing&&<span className="history-step-timing" data-stage={timing.kind}><Clock3 size={12} aria-hidden="true"/><span>{timing.label} · <strong>{formatDuration(timing.durationSeconds!)}</strong></span><span>Начало <ExactTime value={timing.startedAt!}/></span></span>}</span></li>})}</ol>
}
function HistoryContextLink({service,environment,instance,historyRef,value,primary=false}:{service:string;environment?:string;instance?:string;historyRef?:string;value:string;primary?:boolean}){
 return <InfoTooltip title={historyRef?`Открыть историю ветки ${historyRef} сервиса ${service}`:`Открыть историю ${instance?'экземпляра':'сервиса'} ${value}`} describeChild><a className={`history-context-link${primary?' primary':''}`} href={serviceHistoryHref(service,environment,instance,historyRef)}>{value}<ArrowRight size={12} aria-hidden="true"/></a></InfoTooltip>
}
function HistoryRow({operation,services,links,serviceKey,instanceName}:{operation:HistoryOperation;services:Service[];links:Links;serviceKey?:string;instanceName?:string}){
  const refs=[...new Map(operation.events.flatMap(event=>historyLinks(event,services,links)).map(link=>[link.url,link])).values()]
  const environment=operation.environment||(operation.ref.startsWith('feature/')?'feature':undefined)
  const historyRef=operation.kind==='build'&&!operation.environment&&!operation.instance?operation.ref:undefined
  return <article className="history-operation" data-history-kind={operation.kind}>
   <SystemIcon system={operation.kind==='argo'?'argocd':'gitlab'} size={22}/>
   <div className="history-operation-body"><div className="history-operation-title"><h3>{operation.title}</h3><span className={`history-result tone-${operation.tone}`}><i/>{operation.status}</span></div>
    <div className="history-operation-meta">{!serviceKey&&<HistoryContextLink service={operation.service} environment={environment} instance={operation.instance} historyRef={historyRef} value={operation.service} primary/>}{operation.environment&&<span className="env-label">{operation.environment}</span>}<span><GitBranch size={13}/>{operation.ref}</span>{operation.instance&&operation.instance!==instanceName&&operation.instance!==operation.service&&<HistoryContextLink service={operation.service} environment={environment} instance={operation.instance} value={operation.instance}/>}<ExactTime value={operation.at} received={!operation.events.some(item=>eventTime(item)===operation.at&&hasEventTime(item))}/>{operation.durationSeconds!==undefined&&<InfoTooltip title={`С ${format.format(operation.startedAt!)} до ${format.format(operation.finishedAt!)}. Длительность по времени событий подтвержденных этапов этой попытки.`} describeChild><span className="history-duration" tabIndex={0}><Clock3 size={12} aria-hidden="true"/>Длительность <strong>{formatDuration(operation.durationSeconds)}</strong></span></InfoTooltip>}</div>
    {!!refs.length&&<div className="history-operation-links">{refs.map(ref=><LinkedValue key={ref.url} value={ref.label} href={ref.url} target={ref.label}/>)}</div>}
    {operation.events.length>1||operation.durationSeconds!==undefined?<details className="history-operation-details"><summary><ChevronDown size={14}/>Этапы операции</summary><EventDetails items={operation.events}/></details>:!('event'in operation.events[0].payload)&&operation.events[0].payload.failure_code&&<p className="history-failure">{operation.events[0].payload.failure_code}</p>}
   </div>
  </article>
}
export function History({items,loading,error,services,links,serviceKey,environment,instanceName,sourceRef,historyRef,archived=[],hasMore,onLoadMore,moreLoading,moreError}:{items?:EventRecord[];loading:boolean;error?:string;services:Service[];links:Links;serviceKey?:string;environment?:string;instanceName?:string;sourceRef?:string;historyRef?:string;archived?:Instance[];onOpenArchive?:(instance:Instance)=>void;hasMore?:boolean;onLoadMore?:()=>void;moreLoading?:boolean;moreError?:string}){
 const visible=scopeHistory(items||[],environment,instanceName,sourceRef,historyRef)
 const {operations,technical}=buildHistory(visible)
 return <section className="history-panel operation-history" aria-label="История доставки"><header className="history-heading"><h2>{historyRef?`История ветки ${historyRef}`:'История операций'}</h2><span>Операций: {operations.length}</span></header>
  {!!archived.length&&serviceKey&&<details className="history-archive"><summary><Archive size={14}/>Архив feature · {archived.length}<ChevronDown size={14}/></summary><p>Остановленные экземпляры и последние снимки Applications.</p><ul>{archived.map(item=><li key={item.id}><div><strong><GitBranch size={13}/>{item.source_ref}</strong><small>{item.name}</small></div><span>{item.lifecycle.stopped_at?'Остановлена':!observationMatchesLifecycle(item.lifecycle,latest(item)?.[1]?.uid)?'Предыдущий Application':'Не обнаружена'}</span><Button size="small" endIcon={<ArrowRight size={14}/>} aria-label={`История ${item.source_ref}`} aria-current={instanceName===item.name?'page':undefined} href={serviceHistoryHref(serviceKey,'feature',item.name)}>Открыть историю</Button></li>)}</ul></details>}
  {!visible.length?<div className="empty-state">{error&&!items?'Не удалось загрузить историю. Повторите попытку.':loading?'Загрузка истории…':hasMore?'В загруженной части истории совпадений нет. Загрузите более ранние события.':historyRef?'События для этой ветки пока не получены.':'События для этого окружения пока не получены.'}</div>:<>
   {operations.map(operation=><HistoryRow operation={operation} services={services} links={links} serviceKey={serviceKey} instanceName={instanceName} key={operation.id}/>)}
   {!!technical.length&&<details className="history-technical"><summary><ChevronDown size={15}/>Дополнительно</summary><p>Получено событий: {visible.length}. Служебных сигналов Argo: {technical.length}.</p><EventDetails items={technical}/></details>}
  </>}
  {moreError&&<p className="history-load-error" role="alert">{moreError}</p>}
  {hasMore&&<div className="history-paging"><Button size="small" onClick={onLoadMore} disabled={moreLoading}>{moreLoading?'Загрузка…':'Показать более ранние события'}</Button></div>}
 </section>
}
