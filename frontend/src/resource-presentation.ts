import {short,type Resource,type Relationship} from './data.ts'

export type ResourceField=[string,string]
export const detailGroups=['Runtime','Версии','Размещение','Происхождение'] as const
export type DetailGroup=typeof detailGroups[number]
export const fieldValue=(resource:Resource,name:string)=>resource.fields.find(([label])=>label===name)?.[1]
export const resourceSearchText=(resource:Resource)=>[resource.kind,resource.title,resourceCard(resource).title,...(resource.endpoints||[]).flatMap(endpoint=>[endpoint.label,endpoint.url]),fieldValue(resource,'Routes')].filter(Boolean).join(' ').toLocaleLowerCase()
const fields=(resource:Resource)=>resource.fields.filter(([,value])=>typeof value==='string'&&value!=='')

/** Display policies never change resource identity, facts, edges, or graph geometry. */
export function displayStatus(resource:Resource){
 const status=resource.status
 if(!status||status.label==='Last snapshot'||status.label==='Declared'||status.label==='Referenced')return status
 return resource.system==='kubernetes'&&fieldValue(resource,'Evidence')?.startsWith('Argo ')?{...status,label:`Argo: ${status.label}`}:status
}

/** Visibility follows the reported status, never resource role or inferred readiness. */
export function resourceProblem(resource:Resource){
 const status=displayStatus(resource)
 if(!status||!['danger','warn'].includes(status.tone))return undefined
 const reasons=[...new Set(resource.fields.filter(([key])=>/(^|\s)reason$/i.test(key)&&!/last termination/i.test(key)).map(([,value])=>value).filter(Boolean))]
 return {status,reasons}
}

export function resourceCard(resource:Resource,relationships:Relationship[]=[],namespace?:string){
 let title=resource.title,caption:string|undefined
 const value=(name:string)=>fieldValue(resource,name)
 switch(resource.role){
  case 'repo':caption=value('Branch');break
  case 'image':{
   const reference=value('Image reference')||resource.identity,parts=reference.split('@')
   const digest=value('Digest')||(parts[1]?.startsWith('sha256:')?parts[1]:undefined)
   if(resource.kind==='Observed image')title=parts[0].split('/').slice(-2).join('/')
   caption=digest?`digest ${short(digest)}`:resource.kind==='Observed image'?'Pod image':undefined
   break
  }
  case 'chart':caption=value('Chart ref');break
  case 'sourceValues':caption=value('Common path')?`+ ${value('Common path')}`:undefined;break
  case 'values':caption=value('Revision')?`revision ${short(value('Revision'))}`:undefined;break
  case 'config':caption=value('Branch')?`branch ${value('Branch')}`:value('Revision')?`revision ${short(value('Revision'))}`:undefined;break
  case 'argo':caption=`values: ${value('Values branch')||'Неизвестно'}`;break
  case 'configmap':caption=value('Files');break
  case 'pod':caption=resource.subtitle;break
  case 'workload':caption=resource.subtitle;break
 }
 if(resource.kind==='Service'){
  const consumers=new Set(relationships.filter(edge=>edge.from===resource.id&&edge.label==='selects').map(edge=>edge.to)).size
  const templates=relationships.filter(edge=>edge.from===resource.id&&edge.label==='matches template').length
  if(consumers)caption=`${consumers} selected ${consumers===1?'Pod':'Pods'}`
  else if(templates)caption=`${templates} template ${templates===1?'match':'matches'}`
 }
 if(resource.kind==='Ingress'){
  const endpoint=resource.endpoints?.[0]
  if(endpoint){try{const url=new URL(endpoint.url);title=url.host;caption=url.pathname+(resource.endpoints!.length>1?` · +${resource.endpoints!.length-1} routes`:'')}catch{/* Keep the original name for unavailable metadata. */}}
  else caption=value('Routes')?.split('\n')[0]?.split(' → ')[0]
 }
 const ownNamespace=value('Namespace')
 if(ownNamespace&&ownNamespace!==namespace)caption=[caption,ownNamespace==='Cluster-scoped'?ownNamespace:`ns ${ownNamespace}`].filter(Boolean).join(' · ')
 return {title,caption,status:displayStatus(resource)}
}

function primaryKeys(resource:Resource){
 switch(resource.role){
  case 'repo':return ['Branch','Build revision']
  case 'image':return ['Repository','Digest','Image reference','Build job']
  case 'chart':return ['Chart ref']
  case 'sourceValues':return ['Environment path','Common path','Branch','Revision']
  case 'values':return ['Path','Values branch','Branch','Publisher pipeline']
  case 'config':return ['Branch','Directory','Revision']
  case 'argo':return ['Values branch','Observed at']
  case 'configmap':return ['Files','Published mounts',...fields(resource).filter(([key])=>key.startsWith('File: ')).map(([key])=>key)]
  case 'vault':return ['Remote key','SecretStore','Mount','Property','Properties']
  case 'workload':return resource.kind==='Job'?['Runtime observed at','Active Jobs','Succeeded Jobs','Failed Jobs','Controller conditions','Observed Pods']:['Ready replicas','Target replicas','Updated replicas','Available replicas','Pod restarts','Runtime observed at']
  case 'pod':return ['Pod phase','Pod Ready','Deleting','Runtime observed at',...fields(resource).filter(([key])=>/ (?:image|imageID|restarts|reason|exit code|state)$/.test(key)).map(([key])=>key)]
  case 'secret':return ['ExternalSecret','ESO Health']
  default:return resource.kind==='Service'&&(fieldValue(resource,'Selector')?.length||0)<=80?['Selector']:[]
 }
}

function groupFor(key:string):DetailGroup{
 if(/replicas|Pods|restarts|Jobs|conditions| phase| reason| state|exit code|termination|terminated at|Deleting/i.test(key))return 'Runtime'
 if(/revision|digest|Chart ref|Generation| image(?:ID)?$/i.test(key))return 'Версии'
 if(key.startsWith('File: ')||['Repository','Namespace','Project','Path','Directory','Branch','Values branch','Common path','Environment path','SecretStore','Mount','Properties','Published mounts','Selector','Routes','Remote key','Property','Service type','Ingress class'].includes(key))return 'Размещение'
 return 'Происхождение'
}

export function resourceFields(resource:Resource,mode:'inspector'|'overview'|'technical'='inspector'){
 const keys=primaryKeys(resource),primary:ResourceField[]=[],additional:Record<DetailGroup,ResourceField[]>={Runtime:[],Версии:[],Размещение:[],Происхождение:[]}
 const shownRuntime=resource.role==='workload'&&resource.kind!=='Job'&&resource.componentIds?.length===1&&resource.status?.label!=='Last snapshot'&&fieldValue(resource,'Ready replicas')!==undefined&&fieldValue(resource,'Target replicas')!==undefined
 const visible=mode==='overview'?resource.role==='repo'?['Branch']:resource.role==='argo'?['Sync','Health','Values branch','Chart ref']:resource.role==='chart'?['Chart ref']:resource.role==='configmap'?['Files']:resource.role==='vault'?['Remote key']:shownRuntime?['Ready replicas','Target replicas','Pod restarts']:resource.role==='config'?['Branch']:[]:[]
 const ordered=fields(resource).sort(([a],[b])=>{const x=keys.indexOf(a),y=keys.indexOf(b);return (x<0?999:x)-(y<0?999:y)})
 for(const entry of ordered){
  const [key]=entry
  if(visible.includes(key))continue
  if(mode!=='technical'&&resource.role==='argo'&&['Sync','Health'].includes(key)&&resource.status?.label===`${fieldValue(resource,'Sync')} · ${fieldValue(resource,'Health')}`)continue
  if(mode==='inspector'&&keys.includes(key))primary.push(entry)
  else additional[groupFor(key)].push(entry)
 }
 return {primary,additional}
}
