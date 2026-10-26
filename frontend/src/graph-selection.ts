type TraceEdge<T extends string>={from:T;to:T;componentIds?:string[];context?:boolean;family?:string;label?:string}
type TraceResource={role:string;kind?:string}
type Purpose='full'|'configuration'|'artifact'|'secret'|'control'
const flowFamilies:Partial<Record<Purpose,ReadonlySet<string>>>= {
 configuration:new Set(['configuration']),artifact:new Set(['source','artifact']),secret:new Set(['secret']),
}

/** Follow causal paths; shared delivery context never becomes another resource's input. */
export function traceResource<T extends string>(selected:T|null,relations:readonly TraceEdge<T>[],resources?:Partial<Record<T,TraceResource>>){
 const nodeIds=new Set<T>(),edges=new Set<(typeof relations)[number]>()
 if(!selected)return {nodeIds,edges}
 const components=new Set(relations.flatMap(edge=>edge.from===selected||edge.to===selected?edge.componentIds||[]:[]))
 const role=(id:T)=>resources?.[id]?.role
 const selectedRole=role(selected)
 const commonSelected=!!selectedRole&&['repo','sourceValues','config','values','chart','argo'].includes(selectedRole)
 const inScope=(edge:TraceEdge<T>)=>commonSelected||edge.componentIds===undefined||(edge.componentIds.length?edge.componentIds.some(id=>components.has(id)):components.size===0)
 const add=(edge:TraceEdge<T>)=>{edges.add(edge);nodeIds.add(edge.from);nodeIds.add(edge.to)}

 // Retain the generic contract for callers without a typed resource inventory.
 if(!resources){
  const pending=[selected]
  while(pending.length){const node=pending.pop()!;if(nodeIds.has(node))continue;nodeIds.add(node);for(const edge of relations){if(edge.to===node&&inScope(edge)){edges.add(edge);pending.push(edge.from)}}}
  for(const edge of relations)if(edge.from===selected&&inScope(edge)){edges.add(edge);nodeIds.add(edge.to)}
  return {nodeIds,edges}
 }
 const initial:Purpose=selectedRole==='config'||selectedRole==='configmap'?'configuration':selectedRole==='image'||selectedRole==='repo'?'artifact':['secret','eso','vault'].includes(selectedRole||'')?'secret':'full'
 const upstreamSeen=new Set<string>()
 const upstream=(start:T,purpose:Purpose)=>{
  const pending:{id:T;purpose:Purpose}[]=[{id:start,purpose}]
  while(pending.length){
   const current=pending.pop()!,visit=current.id+'\0'+current.purpose
   if(upstreamSeen.has(visit))continue
   upstreamSeen.add(visit);nodeIds.add(current.id)
   for(const edge of relations){
    if(edge.to!==current.id||!inScope(edge))continue
    const fromRole=role(edge.from),toRole=role(edge.to)
    if(toRole==='values'){
     if((fromRole==='image'||edge.family==='artifact')&&!['full','artifact'].includes(current.purpose))continue
     if((fromRole==='config'||edge.label==='config files')&&!['full','configuration'].includes(current.purpose))continue
    }
    add(edge)
    let next=current.purpose
    if(edge.label==='manages'||toRole==='argo')next='control'
    else if(fromRole==='values'&&toRole==='configmap')next='configuration'
    pending.push({id:edge.from,purpose:next})
   }
  }
 }
 upstream(selected,initial)
 const downstreamSeen=new Set<string>(),pending:{id:T;purpose:Purpose}[]=[{id:selected,purpose:initial}]
 const explicitControl=!!selectedRole&&['argo','values','sourceValues','chart'].includes(selectedRole)
 while(pending.length){
  const current=pending.pop()!,visit=current.id+'\0'+current.purpose
  if(downstreamSeen.has(visit))continue
  downstreamSeen.add(visit)
  for(const edge of relations){
   if(edge.from!==current.id||!inScope(edge))continue
   const fromRole=role(edge.from),toRole=role(edge.to)
   if(fromRole==='argo'&&edge.label==='manages'&&!explicitControl)continue
   if(fromRole==='values'&&toRole!=='argo'&&current.purpose==='artifact')continue
   // An input reaches its consumers and their owned runtime, without turning
   // a TLS/registry/config dependency into an unrelated traffic or data flow.
   const families=flowFamilies[current.purpose]
   if(families&&edge.family&&!families.has(edge.family)&&edge.label!=='owns'&&toRole!=='argo')continue
   add(edge)
   if(edge.label==='matches template')continue
   if(toRole==='argo'){
    upstream(edge.to,'control')
    if(explicitControl)pending.push({id:edge.to,purpose:'control'})
   }else pending.push({id:edge.to,purpose:current.purpose})
  }
 }
 // A controller also exposes the actual inputs of its UID descendants, including
 // old rollout images. Other selections do not pull in a consumer's inputs.
 if(selectedRole==='workload'||selectedRole==='replicaSet'||['Deployment','StatefulSet','DaemonSet','Job','ReplicaSet'].includes(resources[selected]?.kind||'')){
  const owned=[selected],seen=new Set<T>()
  while(owned.length){
   const current=owned.pop()!
   if(seen.has(current))continue
   seen.add(current)
   if(role(current)==='pod')upstream(current,'full')
   for(const edge of relations)if(edge.from===current&&edge.label==='owns'&&inScope(edge))owned.push(edge.to)
  }
 }
 return {nodeIds,edges}
}
