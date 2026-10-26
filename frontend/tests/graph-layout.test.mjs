import test from 'node:test'
import assert from 'node:assert/strict'
import {layoutResourceGraph,readableViewport,GRAPH_NODE_HEIGHT,GRAPH_NODE_WIDTH} from '../src/graph-layout.ts'
import {edgeColor,edgeFamilies} from '../src/edge-semantics.ts'
const resource=(id,role,componentIds=[],kind=role)=>({id,role,kind,componentIds})
const components=[{id:'component:api',key:'api'},{id:'component:worker',key:'worker'}]
const resources=[resource('repo','repo'),resource('values','values'),resource('chart','chart'),resource('argo','argo'),resource('config','config'),resource('api-image','image',['component:api']),resource('api-config','configmap',['component:api']),resource('api','workload',['component:api']),resource('api-rs','replicaSet',['component:api']),resource('api-pod','pod',['component:api']),resource('worker-image','image',['component:worker']),resource('worker','workload',['component:worker']),resource('shared-secret','secret',['component:api','component:worker'])]
const edges=[{from:'repo',to:'api-image',label:'build source'},{from:'api-image',to:'api',label:'desired image'},{from:'argo',to:'api',label:'manages'},{from:'api',to:'api-rs',label:'owns'},{from:'api-rs',to:'api-pod',label:'owns'}]
test('component lanes are explicit, shared resources are not cloned, and source stays vertically centered',()=>{
 const graph=layoutResourceGraph(resources,edges,components)
 assert.equal(graph.nodes.length,resources.length)
 assert.equal(new Set(graph.nodes.map(node=>node.id)).size,resources.length)
 const api=graph.groups.find(group=>group.id==='component:api'),worker=graph.groups.find(group=>group.id==='component:worker'),shared=graph.groups.find(group=>group.shared)
 assert.ok(api.resourceIds.includes('api-config')&&api.resourceIds.includes('api-pod'))
 assert.ok(!api.resourceIds.includes('worker-image')&&!worker.resourceIds.includes('api-image'))
 assert.ok(shared.resourceIds.includes('shared-secret')&&shared.resourceIds.includes('chart'))
 assert.ok(api.y+api.height<worker.y)
 const source=graph.nodes.find(node=>node.id==='repo')
 assert.equal(source.y+GRAPH_NODE_HEIGHT/2,graph.height/2)
 assert.ok(graph.nodes.every(node=>node.id==='repo'||node.x>source.x))
 for(const edge of graph.edges){const a=graph.nodes.find(node=>node.id===edge.from),b=graph.nodes.find(node=>node.id===edge.to);assert.ok(a.x<b.x)}
})
test('status and revision polling cannot move geometry or change camera policy',()=>{
 const first=layoutResourceGraph(resources,edges,components)
 const refreshed=layoutResourceGraph(resources.map(resource=>({...resource,title:'new-title',subtitle:'new-revision',status:{label:'Failed',tone:'danger'}})),edges,components)
 assert.deepEqual(refreshed,first)
 const viewport=readableViewport(first,900,650)
 assert.ok(viewport.zoom>=.9)
 assert.deepEqual(viewport,readableViewport(refreshed,900,650))
 const selected=readableViewport(first,900,650,'api-pod'),pod=first.nodes.find(node=>node.id==='api-pod')
 assert.ok(pod.x*selected.zoom+selected.x>=0)
})
test('a long image link routes around the intermediate configuration cards',()=>{
 const graph=layoutResourceGraph(resources,edges,components),edge=graph.edges.find(edge=>edge.from==='api-image'&&edge.to==='api')
 const points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))
 const obstacles=graph.nodes.filter(node=>node.id!==edge.from&&node.id!==edge.to)
 for(let index=1;index<points.length;index++){
  const a=points[index-1],b=points[index]
  for(const node of obstacles){
   const crosses=a.x===b.x?a.x>node.x&&a.x<node.x+GRAPH_NODE_WIDTH&&Math.max(a.y,b.y)>node.y&&Math.min(a.y,b.y)<node.y+GRAPH_NODE_HEIGHT:a.y>node.y&&a.y<node.y+GRAPH_NODE_HEIGHT&&Math.max(a.x,b.x)>node.x&&Math.min(a.x,b.x)<node.x+GRAPH_NODE_WIDTH
   assert.equal(crosses,false,`route intersects ${node.id}`)
  }
 }
})
test('selection uses one path color while inactive and dimmed relationships stay neutral',()=>{
 for(const family of Object.keys(edgeFamilies)){
  assert.equal(edgeColor(family,false,false),'var(--edge-neutral)')
  assert.equal(edgeColor(family,false,true),'var(--edge-neutral)')
  assert.equal(edgeColor(family,true,false),'var(--graph-active-path)')
  assert.equal(edgeColor(family,true,true),'var(--edge-neutral)')
 }
 assert.equal(new Set(Object.values(edgeFamilies).map(family=>family.dash||'solid')).size,Object.keys(edgeFamilies).length)
})
test('unassigned resources remain reachable without inventing a component',()=>{
 const graph=layoutResourceGraph([resource('repo','repo'),resource('unknown','resource')],[],[])
 assert.equal(graph.nodes.length,2)
 assert.deepEqual(graph.groups.find(group=>group.id==='unassigned-resources').resourceIds,['unknown'])
 assert.ok(Number.isFinite(graph.width)&&Number.isFinite(graph.height))
})
test('unassigned resources use a compact grid and shared bounds do not span empty component columns',()=>{
 const unknown=Array.from({length:5},(_,i)=>resource(`extra-${i}`,'resource'))
 const graph=layoutResourceGraph([...resources,...unknown],edges,components)
 const group=graph.groups.find(g=>g.id==='unassigned-resources'),shared=graph.groups.find(g=>g.shared),api=graph.groups.find(g=>g.id==='component:api')
 assert.ok(group.height<500&&group.width<1000)
 assert.ok(new Set(graph.nodes.filter(n=>n.id.startsWith('extra-')).map(n=>n.x)).size===3)
 assert.ok(shared.width<api.width)
})
test('Argo management links to earlier network columns route above cards',()=>{
 const input=[...resources,resource('entry','resource',['component:api'],'Ingress'),resource('service','resource',['component:api'],'Service')]
 const graph=layoutResourceGraph(input,[...edges,{from:'argo',to:'entry',label:'manages',family:'control'},{from:'argo',to:'service',label:'manages',family:'control'}],components)
 for(const edge of graph.edges.filter(e=>e.from==='argo'&&['entry','service'].includes(e.to))){
  const points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:Number(m[1]),y:Number(m[2])}))
  for(let i=1;i<points.length;i++)for(const node of graph.nodes.filter(n=>n.id!==edge.from&&n.id!==edge.to)){
   const a=points[i-1],b=points[i]
   const crossing=a.x===b.x?a.x>node.x&&a.x<node.x+GRAPH_NODE_WIDTH&&Math.max(a.y,b.y)>node.y&&Math.min(a.y,b.y)<node.y+GRAPH_NODE_HEIGHT:a.y>node.y&&a.y<node.y+GRAPH_NODE_HEIGHT&&Math.max(a.x,b.x)>node.x&&Math.min(a.x,b.x)<node.x+GRAPH_NODE_WIDTH
   assert.equal(crossing,false,`management route intersects ${node.id}`)
  }
 }
})
