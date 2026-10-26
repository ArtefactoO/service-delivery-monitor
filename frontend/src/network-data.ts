import {kubernetesGroup,kubernetesIdentity,kubernetesResourceIds,type KubernetesIdResolver,type Resource,type Relationship} from './data.ts'
import type {RuntimeSnapshot} from './runtime-data'

export interface IngressRoute {host:string;path:string;path_type:string;tls:boolean;service_name?:string}
export function ingressUrl(route:IngressRoute):string|undefined {
  if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(route.host))return
  let path=route.path||'/'
  if(!path.startsWith('/')||/[\x00-\x20\\?#]/.test(path))return
  if(route.path_type==='ImplementationSpecific'){
    // The shared chart's feature rewrite has a concrete prefix, not a clickable regex.
    path=path.replace(/\(\/\|\$\)\(\.\*\)\$?$/, '/')
    if(/[()*+?\[\]{}|^$]/.test(path))return
  }
  try{
    const origin=`${route.tls?'https':'http'}://${route.host}`
    const url=new URL(origin+path)
    if(url.origin!==new URL(origin).origin||url.username||url.password)return
    return url.href
  }catch{return}
}

/** Native selectors and references establish membership, never resource-name similarity. */
export function enrichNetwork(data:Record<string,Resource>,edges:Relationship[],runtime?:RuntimeSnapshot,argoUrl?:string,resourceId?:KubernetesIdResolver){
  if(!runtime)return
  const id=resourceId||kubernetesResourceIds(data,runtime)
  const reference=(kind:string,name:string,namespace:string)=>{
    const key=id(kind,name,namespace)
    if(!data[key])data[key]={id:key,role:kind==='Secret'?'secret':'resource',kind:kind==='Secret'?'Kubernetes Secret':kind,title:name,system:'kubernetes',identity:kubernetesIdentity(kind,name,namespace),apiGroup:kubernetesGroup(kind),description:'Точная ссылка из Kubernetes spec. Готовность ресурса отдельно не подтверждена.',fields:[['Namespace',namespace],['API group',kubernetesGroup(kind)||'core']],linkLabel:'Открыть ресурс в Argo',url:argoUrl?argoUrl+'?view=tree':undefined,status:{label:'Referenced',tone:'muted'}}
    return key
  }
  const edge=(from:string,to:string,label:string)=>{if(data[from]&&data[to]&&!edges.some(e=>e.from===from&&e.to===to&&e.label===label))edges.push({from,to,label,family:label==='TLS secret'?'secret':'configuration',evidence:'kubernetes-spec'})}
  const controllers=runtime.objects.filter(o=>['Deployment','StatefulSet','DaemonSet','Job'].includes(o.kind))
  for(const object of controllers){
    if(object.service_account&&/^[a-z0-9][a-z0-9.-]*$/.test(object.service_account))edge(reference('ServiceAccount',object.service_account,object.namespace),id(object.kind,object.name,object.namespace,object.group),'service account')
  }
  for(const object of runtime.objects){
    const key=id(object.kind,object.name,object.namespace,object.group),resource=data[key]
    if(!resource)continue
    if(object.kind==='Service'){
      if(object.service_type)resource.fields.push(['Service type',object.service_type])
      const selector=Object.entries(object.selector||{})
      resource.fields.push(['Selector',selector.map(([key,value])=>`${key}=${value}`).join(', ')||'No selector'])
      if(!selector.length)continue
      const matches=(target:(typeof runtime.objects)[number])=>target.namespace===object.namespace&&selector.every(([name,value])=>target.pod_labels?.[name]===value)
      const pods=runtime.objects.filter(o=>o.kind==='Pod'&&matches(o)),templates=controllers.filter(matches)
      for(const target of pods)edge(key,id(target.kind,target.name,target.namespace,target.group),'selects')
      for(const target of templates)edge(key,id(target.kind,target.name,target.namespace,target.group),'matches template')
      resource.fields.push(['Selected Pods',String(pods.length)],['Matching templates',String(templates.length)])
    }
    if(object.kind==='Ingress'){
      for(const secret of object.tls_secrets||[])edge(reference('Secret',secret,object.namespace),key,'TLS secret')
      if(object.ingress_class)resource.fields.push(['Ingress class',object.ingress_class])
      if(object.default_backend_service){
        resource.fields.push(['Default backend',object.default_backend_service])
        edge(key,reference('Service',object.default_backend_service,object.namespace),'default backend')
      }
      resource.endpoints=[]
      for(const route of object.routes||[]){
        const url=ingressUrl(route)
        if(url&&!resource.endpoints.some(item=>item.url===url))resource.endpoints.push({url,label:new URL(url).host+new URL(url).pathname})
        if(route.service_name)edge(key,reference('Service',route.service_name,object.namespace),'routes to')
      }
      resource.fields.push(['Routes',(object.routes||[]).map(route=>`${route.host}${route.path} → ${route.service_name||'resource backend'}`).join('\n')])
    }
  }
}
