import test from 'node:test'
import assert from 'node:assert/strict'
import {layoutResourceGraph,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT} from '../src/graph-layout.ts'
import {boxesOverlap} from '../src/graph-labels.ts'

// Same supported topology as the 28-resource, 50-edge map regression: the
// management links and the remoteRef links used to share overlapping captions.
function topology(count=2,shared=false){
 const components=Array.from({length:count},(_,index)=>{const key=count===2?['api','worker'][index]:'component-'+index;return{id:'component:'+key,key}}),resources=[],edges=[]
 const add=(id,role,kind,componentIds=[])=>resources.push({id,role,kind,componentIds})
 const edge=(from,to,label,family)=>edges.push({from,to,label,family})
 for(const role of ['repo','sourceValues','config','values','chart','argo'])add(role,role,role)
 edge('sourceValues','values','merge','configuration');edge('config','values','config files','configuration');edge('chart','argo','chart source','configuration');edge('values','argo','Git source','control')
 if(shared)for(const [id,role,kind]of [['shared-image','image','Container image'],['shared-vault','vault','Vault reference'],['shared-secret','secret','Kubernetes Secret']])add(id,role,kind,components.map(component=>component.id))
 for(const [index,component]of components.entries()){
  const ids={}
  for(const [role,kind]of [['image','Container image'],['vault','Vault reference'],['eso','ExternalSecret'],['secret','Kubernetes Secret'],['configmap','ConfigMap'],['account','ServiceAccount'],['service','Service'],['ingress','Ingress'],['workload','Deployment'],['replicaSet','ReplicaSet'],['pod','Pod']]){
   if(shared&&['image','vault'].includes(role)){ids[role]='shared-'+role;continue}
   const name={eso:'app-'+component.key+'-runtime',secret:'app-'+component.key+'-runtime',configmap:'app-'+component.key+'-config',account:component.key+'-account',service:component.key+'-http',ingress:component.key+'-edge',workload:'app-'+component.key,replicaSet:component.key+'-set',pod:component.key+'-pod'}[role]
   const id=role==='image'?'image:registry.example/shared-app@sha256:'+String(index+1).repeat(64):role==='vault'?'vault:vault:services/'+component.key:'k8s:scope:'+kind+':'+name
   ids[role]=id;add(id,['account','service','ingress'].includes(role)?'resource':role,kind,[component.id])
  }
  edge('repo',ids.image,'build source','source');edge(ids.image,'values','digest','artifact');edge(ids.image,ids.workload,'desired image','artifact');edge(ids.image,ids.pod,'runs','artifact')
  edge('values',ids.configmap,'config data','configuration');edge(ids.configmap,ids.workload,'mount','configuration');edge(ids.configmap,ids.pod,'mount','configuration')
  edge(ids.vault,ids.eso,'remoteRef','secret');edge(ids.eso,ids.secret,'target','secret');edge(ids.secret,ids.workload,'envFrom','secret');edge(shared?'shared-secret':ids.secret,ids.pod,'envFrom','secret')
  if(shared)edge('shared-secret',ids.workload,'env','secret')
  edge(ids.account,ids.workload,'service account','configuration');edge(ids.account,ids.pod,'service account','configuration');edge(ids.service,ids.workload,'selects','configuration');edge(ids.ingress,ids.service,'routes to','configuration');edge(ids.workload,ids.replicaSet,'owns','control');edge(ids.replicaSet,ids.pod,'owns','control')
  for(const role of ['eso','configmap','account','service','ingress','workload'])edge('argo',ids[role],'manages','control')
 }
 return {resources,components,edges:[...new Map(edges.map(edge=>[edge.from+'|'+edge.label+'|'+edge.to,edge])).values()]}
}

const labelBox=edge=>({x:edge.labelX-edge.labelWidth/2,y:edge.labelY-edge.labelHeight/2,width:edge.labelWidth,height:edge.labelHeight})
const caption=edge=>edge.id.split('|')[1]
function assertReadable(graph){
 const cards=graph.nodes.map(node=>({...node,width:GRAPH_NODE_WIDTH,height:GRAPH_NODE_HEIGHT})),headings=graph.groups.map(group=>({id:group.id,x:group.x+20,y:group.y+13,width:Math.min(group.width-40,group.label.length*9+95),height:24}))
 for(let index=0;index<graph.edges.length;index++){
  const edge=graph.edges[index],box=labelBox(edge)
  assert.ok([box.x,box.y,box.width,box.height].every(Number.isFinite))
  for(const obstacle of [...cards,...headings])assert.ok(!boxesOverlap(box,obstacle),edge.id+' caption covers '+obstacle.id)
  for(const other of graph.edges.slice(0,index)){
   const prior=labelBox(other),exact=caption(edge)===caption(other)&&box.x===prior.x&&box.y===prior.y
   assert.ok(exact||!boxesOverlap(box,prior),edge.id+' caption overlaps '+other.id)
  }
  const points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))
  const distance=Math.min(...points.slice(1).map((point,i)=>{
   const start=points[i],xMin=Math.min(start.x,point.x),xMax=Math.max(start.x,point.x),yMin=Math.min(start.y,point.y),yMax=Math.max(start.y,point.y)
   return Math.hypot(Math.max(0,box.x-xMax,xMin-(box.x+box.width)),Math.max(0,box.y-yMax,yMin-(box.y+box.height)))
  }))
  assert.ok(distance<=40||edge.labelLeaderPath,edge.id+' caption detached from its route by '+distance)
  if(edge.labelLeaderPath){
   const leader=[...edge.labelLeaderPath.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]})),[start,end]=leader
   assert.equal(leader.length,2)
   assert.ok(points.slice(1).some((p,i)=>{
    const a=points[i]
    return a.x===p.x?start.x===a.x&&start.y>=Math.min(a.y,p.y)&&start.y<=Math.max(a.y,p.y):start.y===a.y&&start.x>=Math.min(a.x,p.x)&&start.x<=Math.max(a.x,p.x)
   }),edge.id+' leader starts on the wrong wire')
   assert.ok(end.x>=box.x&&end.x<=box.x+box.width&&end.y>=box.y&&end.y<=box.y+box.height,edge.id+' leader misses its caption')
   const corridor={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.max(.01,Math.abs(start.x-end.x)),height:Math.max(.01,Math.abs(start.y-end.y))}
   for(const obstacle of [...cards,...headings])assert.ok(!boxesOverlap(corridor,obstacle),edge.id+' leader crosses '+obstacle.id)
  }
  for(const other of graph.edges.filter(other=>caption(other)!==caption(edge))){
   const route=[...other.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))
   for(let i=1;i<route.length;i++){
    const a=route[i-1],b=route[i]
    const crossing=a.y===b.y?a.y>box.y&&a.y<box.y+box.height&&Math.min(a.x,b.x)<box.x+box.width&&Math.max(a.x,b.x)>box.x:
     a.x>box.x&&a.x<box.x+box.width&&Math.min(a.y,b.y)<box.y+box.height&&Math.max(a.y,b.y)>box.y
    assert.equal(crossing,false,edge.id+' caption masks '+other.id)
   }
  }
 }
}

test('the 28-node/50-edge map separates manages and remoteRef captions',()=>{
 const input=topology(),graph=layoutResourceGraph(input.resources,input.edges,input.components)
 assert.equal(graph.nodes.length,28);assert.equal(graph.edges.length,50)
 assertReadable(graph)
})

test('all supported component links avoid cards, headings and other captions with and without shared inputs',()=>{
 for(const count of [1,2,4,8])for(const shared of [false,true]){
  const input=topology(count,shared)
  assertReadable(layoutResourceGraph(input.resources,input.edges,input.components))
 }
})

test('caption positions and route paths stay stable across statuses, versions and selection',()=>{
 const input=topology(4,true),before=layoutResourceGraph(input.resources,input.edges,input.components)
 const changed=input.resources.map(resource=>({...resource,selected:resource.role==='eso',status:{label:'Degraded'},subtitle:'new revision',freshness:{checkedAt:'2030-01-01'}}))
 assert.deepEqual(layoutResourceGraph(changed,input.edges,input.components),before)
})
