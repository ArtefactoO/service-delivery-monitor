import test from 'node:test'
import assert from 'node:assert/strict'
import {layoutResourceGraph,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT} from '../src/graph-layout.ts'
import {planResourceBuses,splitBusRoutes} from '../src/graph-buses.ts'

const parse=path=>[...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))
const onSegment=(p,a,b)=>a.x===b.x?Math.abs(p.x-a.x)<.001&&p.y>=Math.min(a.y,b.y)&&p.y<=Math.max(a.y,b.y):Math.abs(p.y-a.y)<.001&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)
const contains=(p,path)=>path.slice(1).some((b,i)=>onSegment(p,path[i],b))
function topology(count=3){
 const components=Array.from({length:count},(_,i)=>({id:'component:'+i,key:'app-'+i})),resources=[{id:'repo',role:'repo',kind:'Source code'},{id:'argo',role:'argo',kind:'Argo Application'}],edges=[]
 for(const c of components)for(const [role,kind]of [['configmap','ConfigMap'],['eso','ExternalSecret'],['workload','Deployment']]){
  const id=c.id+':'+role;resources.push({id,role,kind,componentIds:[c.id]});edges.push({from:'argo',to:id,label:'manages',family:'control'})
 }
 return{components,resources,edges}
}
test('one management bus retains every real resource, relationship and terminal arrow',()=>{
 const input=topology(),graph=layoutResourceGraph(input.resources,input.edges,input.components)
 assert.equal(graph.nodes.length,input.resources.length)
 assert.equal(graph.edges.length,input.edges.length)
 assert.equal(graph.renderEdges.filter(p=>p.arrow).length,input.edges.length)
 const captions=graph.renderEdges.flatMap(p=>p.captions)
 assert.equal(captions.filter(c=>c.text==='manages').length,1)
 assert.equal(captions[0].edgeIds.length,input.edges.length)
 const byNode=new Map(graph.nodes.map(n=>[n.id,n]))
 for(const logical of graph.edges){
  const points=parse(logical.path),source=byNode.get(logical.from),target=byNode.get(logical.to)
  assert.equal(points[0].x,source.x+GRAPH_NODE_WIDTH)
  assert.equal(points.at(-1).x,target.x)
  assert.ok(points.at(-1).y>=target.y&&points.at(-1).y<=target.y+GRAPH_NODE_HEIGHT)
  const arrow=graph.renderEdges.find(p=>p.arrow&&p.edgeIds.includes(logical.id))
  assert.ok(arrow);assert.equal(arrow.to,logical.to);assert.deepEqual(parse(arrow.path).at(-1),points.at(-1))
 }
 for(const caption of graph.renderEdges.flatMap(p=>p.captions)){
  const logical=graph.edges.find(e=>e.id===caption.id),box={left:caption.labelX-logical.labelWidth/2,right:caption.labelX+logical.labelWidth/2,top:caption.labelY-logical.labelHeight/2,bottom:caption.labelY+logical.labelHeight/2}
  for(const g of graph.groups){
   const horizontal=box.left<g.x+g.width&&box.right>g.x&&(box.top<g.y&&box.bottom>g.y||box.top<g.y+g.height&&box.bottom>g.y+g.height)
   const vertical=box.top<g.y+g.height&&box.bottom>g.y&&(box.left<g.x&&box.right>g.x||box.left<g.x+g.width&&box.right>g.x+g.width)
   assert.ok(!horizontal&&!vertical,'caption overlaps a component frame')
  }
 }
})
test('every shared segment lists exactly the relationships traversing it',()=>{
 for(const count of [1,2,4]){
  const input=topology(count),graph=layoutResourceGraph(input.resources,input.edges,input.components)
  for(const part of graph.renderEdges){
   const points=parse(part.path),a=points[0],b=points.at(-1),middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
   const expected=graph.edges.filter(e=>e.busId===part.busId&&contains(middle,parse(e.path))).map(e=>e.id).sort()
   assert.deepEqual(part.edgeIds,expected)
  }
 }
})
test('choosing one consumer highlights its prefix without lighting a sibling branch',()=>{
 const input=topology(2),graph=layoutResourceGraph(input.resources,input.edges,input.components)
 const chosen=graph.edges.find(e=>e.to==='component:0:workload'),sibling=graph.edges.find(e=>e.to==='component:1:workload')
 const active=graph.renderEdges.filter(p=>p.edgeIds.includes(chosen.id))
 assert.ok(active.some(p=>p.edgeIds.includes(sibling.id)),'shared prefix must remain connected')
 assert.ok(graph.renderEdges.some(p=>p.edgeIds.includes(sibling.id)&&!p.edgeIds.includes(chosen.id)),'sibling needs its own branch')
 assert.ok(!active.some(p=>p.arrow&&p.to===sibling.to))
})
test('shared sections have one common endpoint and never combine different labels or families',()=>{
 const input=topology(2)
 input.resources.push({id:'another-source',role:'argo',kind:'Argo Application'})
 const links=[...input.edges,...input.edges.map(e=>({...e,from:'another-source'})),...input.edges.map(e=>({...e,label:'config data',family:'configuration'}))]
 const graph=layoutResourceGraph(input.resources,links,input.components),byId=new Map(links.map(e=>[`${e.from}|${e.label}|${e.to}`,e]))
 for(const part of graph.renderEdges){
  const members=part.edgeIds.map(id=>byId.get(id))
  const identities=new Set(members.map(e=>JSON.stringify([e.label,e.family])))
  assert.equal(identities.size,1)
  assert.ok(new Set(members.map(e=>e.from)).size===1||new Set(members.map(e=>e.to)).size===1)
 }
 const changed=layoutResourceGraph(input.resources.map(r=>({...r,status:{label:'Failed'},subtitle:'new'})),links,input.components)
 assert.deepEqual(changed,graph)
})

function star(count,incoming,label='custom relation'){
 const nodes=[{id:'common',x:incoming?600:0,y:300},...Array.from({length:count},(_,i)=>({id:'peer:'+i,x:incoming?0:600,y:i*200}))]
 const links=nodes.slice(1).map(n=>({id:n.id,from:incoming?n.id:'common',to:incoming?'common':n.id,label,family:'artifact'}))
 const byNode=new Map(nodes.map(n=>[n.id,n]))
 const starts=new Map(links.map(e=>[e.id,{x:byNode.get(e.from).x+GRAPH_NODE_WIDTH,y:byNode.get(e.from).y+GRAPH_NODE_HEIGHT/2}]))
 const ends=new Map(links.map(e=>[e.id,{x:byNode.get(e.to).x,y:byNode.get(e.to).y+GRAPH_NODE_HEIGHT/2}]))
 return{nodes,links,ports:{starts,ends}}
}
test('clear bus branches reach their cards without doubling back through the group header',()=>{
 for(const incoming of [false,true])for(const count of [3,5]){
  const {nodes,links,ports}=star(count,incoming)
  const routes=planResourceBuses(links,nodes,[],GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,ports)
  assert.equal(routes.size,count)
  for(const route of routes.values()){
   const start=ports.starts.get(route.id),end=ports.ends.get(route.id)
   const length=route.points.slice(1).reduce((sum,p,i)=>sum+Math.abs(p.x-route.points[i].x)+Math.abs(p.y-route.points[i].y),0)
   assert.equal(length,Math.abs(end.x-start.x)+Math.abs(end.y-start.y),`${incoming?'incoming':'outgoing'} ${route.id}: ${route.path}`)
  }
 }
})
test('a blocked target row still uses a free bus corridor without crossing a card',()=>{
 const {nodes,links,ports}=star(3,false)
 nodes.push({id:'obstacle',x:330,y:0})
 const routes=planResourceBuses(links,nodes,[],GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,ports)
 assert.equal(routes.size,links.length)
 for(const route of routes.values())for(let i=1;i<route.points.length;i++)for(const n of nodes){
  const a=route.points[i-1],b=route.points[i],pad=n.id===route.from||n.id===route.to?0:4
  const crosses=a.y===b.y?a.y>n.y-pad&&a.y<n.y+GRAPH_NODE_HEIGHT+pad&&Math.min(a.x,b.x)<n.x+GRAPH_NODE_WIDTH+pad&&Math.max(a.x,b.x)>n.x-pad:
   a.x>n.x-pad&&a.x<n.x+GRAPH_NODE_WIDTH+pad&&Math.min(a.y,b.y)<n.y+GRAPH_NODE_HEIGHT+pad&&Math.max(a.y,b.y)>n.y-pad
  assert.ok(!crosses,`${route.id} crosses ${n.id}`)
 }
})
test('the same degree threshold applies to arbitrary incoming and outgoing relations',()=>{
 for(const incoming of [false,true])for(const label of ['manages','digest','custom relation'])for(const count of [1,2,3,5]){
  const {nodes,links,ports}=star(count,incoming,label)
  const planned=planResourceBuses(links,nodes,[],GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,ports)
  assert.equal(planned.size,count>=3?count:0,`${incoming?'in':'out'} ${label} ${count}`)
  if(count>=3)assert.equal(new Set([...planned.values()].map(p=>p.busId)).size,1)
 }
})
test('fan-in joins incoming branches, preserves arrow direction and animates only real complete paths',()=>{
 const {nodes,links,ports}=star(4,true,'digest')
 const planned=planResourceBuses(links,nodes,[],GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,ports),parts=splitBusRoutes([...planned.values()])
 const arrows=parts.filter(p=>p.arrow)
 assert.equal(arrows.length,1)
 assert.deepEqual(arrows[0].edgeIds,links.map(e=>e.id).sort())
 assert.equal(arrows[0].to,'common')
 const animated=parts.flatMap(p=>p.animations||[])
 assert.deepEqual(animated.map(a=>a.edgeId).sort(),links.map(e=>e.id).sort())
 for(const edge of links){
  const route=planned.get(edge.id),points=parse(route.path)
  assert.deepEqual(points[0],ports.starts.get(edge.id));assert.deepEqual(points.at(-1),ports.ends.get(edge.id))
  assert.equal(animated.find(a=>a.edgeId===edge.id).path,route.path)
  const selected=parts.filter(p=>p.edgeIds.includes(edge.id))
  assert.ok(selected.some(p=>p.edgeIds.length===links.length),'shared suffix is connected')
  for(const other of links.filter(e=>e!==edge))assert.ok(parts.some(p=>p.edgeIds.includes(other.id)&&!selected.includes(p)),'sibling branch stays inactive')
 }
 for(const part of parts){
  const points=parse(part.path),a=points[0],b=points.at(-1),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
  assert.deepEqual(part.edgeIds,[...planned.values()].filter(e=>contains(mid,e.points)).map(e=>e.id).sort())
 }
})
test('several component images converge into values without any Argo resource',()=>{
 const components=Array.from({length:4},(_,i)=>({id:'component:'+i,key:'app-'+i}))
 const resources=[{id:'values',role:'values',kind:'Generated values'},...components.map(c=>({id:c.id+':image',role:'image',kind:'Container image',componentIds:[c.id]}))]
 const links=resources.slice(1).map(r=>({from:r.id,to:'values',label:'digest',family:'artifact'}))
 const graph=layoutResourceGraph(resources,links,components)
 assert.equal(graph.edges.length,4);assert.equal(new Set(graph.edges.map(e=>e.busId)).size,1)
 assert.ok(graph.edges.every(e=>e.busId))
 assert.equal(graph.renderEdges.flatMap(e=>e.captions).filter(c=>c.text==='digest').length,1)
 assert.equal(graph.renderEdges.filter(e=>e.arrow).length,1)
})
test('overlapping fan-in and fan-out candidates keep every relationship exactly once and stay deterministic',()=>{
 const components=Array.from({length:4},(_,i)=>({id:'c'+i,key:'app-'+i}))
 const sources=components.map(c=>({id:c.id,role:'image',kind:'Container image',componentIds:[c.id]}))
 const targets=Array.from({length:3},(_,i)=>({id:'target'+i,role:'values',kind:'Generated values'})),resources=[...sources,...targets]
 const links=sources.flatMap(s=>targets.map(t=>({from:s.id,to:t.id,label:'dependency',family:'artifact'})))
 const graph=layoutResourceGraph(resources,links,components)
 assert.equal(graph.edges.length,links.length)
 assert.equal(new Set(graph.edges.map(e=>e.id)).size,links.length)
 assert.deepEqual(graph,layoutResourceGraph([...resources].reverse(),[...links].reverse(),components))
 for(const edge of graph.edges){
  assert.ok(graph.renderEdges.some(p=>p.arrow&&p.edgeIds.includes(edge.id)))
  assert.equal(graph.renderEdges.flatMap(p=>p.animations||[]).filter(a=>a.edgeId===edge.id).length,1)
 }
})
