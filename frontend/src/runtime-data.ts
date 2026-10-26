import {kubernetesGroup,kubernetesIdentity,kubernetesResourceIds,type KubernetesIdResolver,type Resource,type Relationship,type RelationshipEvidence} from './data.ts'
import type {IngressRoute} from './network-data'
import {argoResourceStatus} from './argo-status.ts'
export interface RuntimeRef {uid:string;kind:string;name:string;group?:string;controller?:boolean}
export interface RuntimeCondition {type:string;status:string;reason?:string}
export interface RuntimeNode {uid:string;kind:string;name:string;namespace:string;group:string;resourceVersion:string;parent_refs:RuntimeRef[];health?:string}
export interface RuntimeObject {uid:string;kind:string;name:string;namespace:string;group:string;resourceVersion:string;fetched_at:string;checked_at?:string;owner_refs:RuntimeRef[];deleting:boolean;phase?:string;conditions?:RuntimeCondition[];generation?:number;desired_replicas?:number;status?:Record<string,number|RuntimeCondition[]>;containers?:{name:string;image?:string;image_id?:string;ready:boolean;restarts:number;init:boolean;state?:string;reason?:string;exit_code?:number;last_termination?:{reason?:string;exit_code?:number;finished_at?:string}}[];images?:{name:string;image:string;init?:boolean}[];references?:{kind:string;name:string;relation:string;group?:string}[];pod_labels?:Record<string,string>;selector?:Record<string,string>;service_account?:string;service_type?:string;ingress_class?:string;routes?:IngressRoute[];default_backend_service?:string}
export interface RuntimeSnapshot {application_uid:string;observed_at:string;tree:RuntimeNode[];objects:(RuntimeObject&{tls_secrets?:string[]})[];truncated:boolean}
export interface RuntimeSummary {ready:number;desired:number;controllers?:number;pods:number;restarts:number;observed_at:string;truncated:boolean}
export function enrichRuntime(data:Record<string,Resource>,edges:Relationship[],runtime:RuntimeSnapshot|undefined,argoUrl?:string,intervalSeconds?:number,resourceId?:KubernetesIdResolver){
 if(!runtime)return
 const id=resourceId||kubernetesResourceIds(data,runtime)
 const nodes=new Map(runtime.tree.map(node=>[node.uid,node])),objects=new Map(runtime.objects.map(object=>[object.uid,object]))
 const parents=(uid:string)=>objects.get(uid)?.owner_refs?.filter(r=>r.controller!==false)||nodes.get(uid)?.parent_refs||[]
 const ancestors=(uid:string)=>{const seen=new Set<string>(),pending=parents(uid).map(ref=>ref.uid);while(pending.length){const current=pending.pop()!;if(seen.has(current))continue;seen.add(current);pending.push(...parents(current).map(ref=>ref.uid))}return seen}
 const edge=(from:string,to:string,label:string,family:Relationship['family'],evidence:RelationshipEvidence='kubernetes-spec')=>{if(data[from]&&data[to]&&!edges.some(e=>e.from===from&&e.to===to&&e.label===label))edges.push({from,to,label,family,evidence})}
 const create=(kind:string,name:string,namespace:string,group?:string)=>{const apiGroup=kubernetesGroup(kind,group),native=apiGroup===kubernetesGroup(kind),key=id(kind,name,namespace,apiGroup);if(!data[key])data[key]={id:key,role:!native?'resource':kind==='Pod'?'pod':kind==='ReplicaSet'?'replicaSet':kind==='Secret'?'secret':kind==='ConfigMap'?'configmap':kind==='ExternalSecret'?'eso':'resource',kind:kind==='Secret'&&native?'Kubernetes Secret':kind,title:name,system:'kubernetes',identity:kubernetesIdentity(kind,name,namespace,apiGroup),apiGroup,description:'Ссылка из Kubernetes spec. Собственный статус этого ресурса в Argo не получен.',subtitle:namespace,status:{label:'Referenced',tone:'muted'},fields:[['Namespace',namespace],['API group',apiGroup||'core'],['Evidence','Kubernetes spec reference']],url:argoUrl?argoUrl+'?view=tree':undefined,linkLabel:'Открыть ресурс в Argo'};return key}
 const field=(resource:Resource,name:string)=>resource.fields.find(([key])=>key===name)?.[1]
 const setField=(resource:Resource,name:string,value:string)=>{resource.fields=resource.fields.filter(([key])=>key!==name);resource.fields.push([name,value])}
 const pods=runtime.objects.filter(object=>object.kind==='Pod')
 const needed=new Set(pods.flatMap(pod=>[pod.uid,...ancestors(pod.uid)]))
 for(const node of runtime.tree){
  if((node.kind==='Pod'||node.kind==='ReplicaSet')&&!needed.has(node.uid))continue
  const key=create(node.kind,node.name,node.namespace,node.group),resource=data[key],previous=resource.freshness?.checkedAt
  resource.identity=node.uid
  setField(resource,'UID',node.uid);setField(resource,'Resource version',node.resourceVersion)
  setField(resource,'Evidence',field(resource,'Sync')?'Argo inventory + resource tree':'Argo resource tree')
  if(node.health&&!(previous&&previous>runtime.observed_at&&field(resource,'Health')))setField(resource,'Health',node.health)
  resource.status=argoResourceStatus(field(resource,'Sync'),field(resource,'Health'))
  resource.freshness={checkedAt:previous&&field(resource,'Sync')&&previous<runtime.observed_at?previous:runtime.observed_at,intervalSeconds}
  resource.description='Статус получен из Argo. Метрики Kubernetes runtime показаны отдельно и не меняют Health или Sync.'
  for(const parent of parents(node.uid)){const p=nodes.get(parent.uid);if(p)edge(create(p.kind,p.name,p.namespace,p.group),key,'owns','control','argo-tree')}
 }
 for(const object of runtime.objects){
  const key=create(object.kind,object.name,object.namespace,object.group),resource=data[key]
  resource.identity=object.uid
  setField(resource,'UID',object.uid);setField(resource,'Resource version',object.resourceVersion)
  setField(resource,'Runtime observed at',object.checked_at||runtime.observed_at)
  setField(resource,'Manifest fetched at',object.fetched_at||runtime.observed_at)
  if(object.deleting)setField(resource,'Deleting','True')
  if(object.kind==='Pod'){
   const containers=object.containers||[],regular=containers.filter(c=>!c.init),ready=regular.filter(c=>c.ready).length,expected=object.images?.filter(image=>!image.init).length||0
   const previousReasons=[...new Set(containers.filter(container=>container.restarts>0).map(container=>container.last_termination?.reason).filter(Boolean))]
   resource.subtitle=`${ready}/${expected} containers · ${containers.reduce((sum,c)=>sum+c.restarts,0)} restarts${previousReasons.length?' · '+previousReasons.join(', '):''}`
   setField(resource,'Pod phase',object.phase||'Unknown')
   for(const condition of object.conditions||[])setField(resource,`Pod ${condition.type}`,condition.status+(condition.reason?` · ${condition.reason}`:''))
   for(const container of containers){
    const prefix=container.init?'init '+container.name:container.name
    resource.fields.push([prefix+' image',container.image||'Неизвестно'],[prefix+' imageID',container.image_id||'Неизвестно'],[prefix+' restarts',String(container.restarts)])
    if(container.state)resource.fields.push([prefix+' state',container.state])
    if(container.reason)resource.fields.push([prefix+' reason',container.reason])
    if(container.exit_code!==undefined)resource.fields.push([prefix+' exit code',String(container.exit_code)])
    const last=container.last_termination
    if(last){
     if(last.reason)resource.fields.push([prefix+' last termination reason',last.reason])
     if(last.exit_code!==undefined)resource.fields.push([prefix+' last exit code',String(last.exit_code)])
     if(last.finished_at)resource.fields.push([prefix+' last terminated at',last.finished_at])
    }
   }
   for(const image of object.images||[]){
    let source=Object.values(data).find(r=>r.role==='image'&&r.identity===image.image)?.id
    if(!source){source=`observed-image:${image.image}`;if(!data[source])data[source]={id:source,role:'image',kind:'Observed image',title:image.image,system:'kubernetes',identity:image.image,description:'Image reference из spec Pod. Фактический imageID показан отдельно; происхождение образа не выводится из текущей desired publication.',fields:[['Image reference',image.image]],linkLabel:'Observed image'}}
    edge(source,key,image.init?"init image":"runs","artifact")
   }
   for(const ref of object.references||[])edge(create(ref.kind,ref.name,object.namespace,ref.group),key,ref.relation,ref.kind==='Secret'?'secret':'configuration')
  }else if(['Deployment','StatefulSet','DaemonSet','Job'].includes(object.kind)){
   const status=object.status||{},number=(field:string)=>typeof status[field]==='number'?status[field] as number:0
   if(object.generation!==undefined)setField(resource,'Generation',String(object.generation))
   if(typeof status.observedGeneration==='number')setField(resource,'Observed generation',String(status.observedGeneration))
   const owned=pods.filter(pod=>ancestors(pod.uid).has(object.uid)),restarts=owned.reduce((sum,pod)=>sum+(pod.containers||[]).reduce((n,c)=>n+c.restarts,0),0)
   const desired=object.kind==='DaemonSet'?number('desiredNumberScheduled'):object.desired_replicas??0,ready=object.kind==='DaemonSet'?number('numberReady'):number('readyReplicas')
   if(object.kind==='Job'){
    resource.subtitle=`${number('active')} active · ${number('succeeded')} succeeded`
    resource.fields.push(['Active Jobs',String(number('active'))],['Succeeded Jobs',String(number('succeeded'))],['Failed Jobs',String(number('failed'))])
   }else{
    resource.subtitle=`${ready} / ${desired} Ready${runtime.truncated?' · partial':` · ${restarts} restarts`}`
    resource.fields.push(['Ready replicas',String(ready)],['Target replicas',String(desired)],['Actual replicas',String(number('replicas')||number('currentNumberScheduled'))],['Updated replicas',String(number('updatedReplicas')||number('updatedNumberScheduled'))],['Available replicas',String(number('availableReplicas')||number('numberAvailable'))])
   }
   const conditions=Array.isArray(status.conditions)?status.conditions:[]
   if(conditions.length)resource.fields.push(['Controller conditions',conditions.map(condition=>`${condition.type}: ${condition.status}${condition.reason?` (${condition.reason})`:''}`).join(', ')])
   resource.fields.push(['Observed Pods',String(owned.length)],['Pod restarts',runtime.truncated?'Частичный снимок':String(restarts)])
  }
 }
}
