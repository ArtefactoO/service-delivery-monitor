import test from 'node:test'
import assert from 'node:assert/strict'
import {dependencyColumns} from '../src/graph-columns.ts'
import {traceResource} from '../src/graph-selection.ts'
import {layoutResourceGraph,GRAPH_NODE_WIDTH as W,GRAPH_NODE_HEIGHT as H} from '../src/graph-layout.ts'

const resource=(id,role,kind,componentIds=['a'])=>({id,role,kind,componentIds})
function fixture(shared=false){
 const components=[{id:'a',key:'alpha'},...(shared?[{id:'b',key:'beta'}]:[])],members=components.map(c=>c.id)
 const resources=[resource('vault','vault','Vault reference',members),resource('eso','eso','ExternalSecret',members),resource('certificate','secret','Kubernetes Secret',members)]
 const edges=[{from:'vault',to:'eso',label:'remoteRef',family:'secret',componentIds:members},{from:'eso',to:'certificate',label:'target',family:'secret',componentIds:members}]
 for(const c of components){
  for(const [key,role,kind]of [['entry','resource','Ingress'],['service','resource','Service'],['controller','workload','Deployment'],['set','replicaSet','ReplicaSet'],['pod','pod','Pod'],['registry','secret','Kubernetes Secret']])resources.push(resource(c.id+key,role,kind,[c.id]))
  for(const [from,to,label,family]of [['certificate',c.id+'entry','TLS secret','secret'],[c.id+'entry',c.id+'service','routes to','configuration'],[c.id+'service',c.id+'controller','matches template','configuration'],[c.id+'service',c.id+'pod','selects','configuration'],[c.id+'controller',c.id+'set','owns','control'],[c.id+'set',c.id+'pod','owns','control'],[c.id+'registry',c.id+'pod','image pull secret','secret']])edges.push({from,to,label,family,componentIds:[c.id]})
 }
 return {resources,edges,components,data:Object.fromEntries(resources.map(r=>[r.id,r]))}
}

test('secret provenance reaches TLS consumers without inheriting their traffic routes',()=>{
 for(const shared of [false,true]){
  const f=fixture(shared)
  for(const selected of ['vault','eso','certificate']){
   const trace=traceResource(selected,f.edges,f.data)
   assert.deepEqual([...trace.nodeIds].sort(),['vault','eso','certificate',...f.components.map(c=>c.id+'entry')].sort())
   assert.ok([...trace.edges].every(e=>e.family==='secret'))
  }
  const ingress=traceResource('aentry',f.edges,f.data)
  assert.ok(ingress.nodeIds.has('aservice')&&ingress.nodeIds.has('apod'),'traffic remains available from its own resource')
  assert.deepEqual([...traceResource('aregistry',f.edges,f.data).nodeIds].sort(),['apod','aregistry'])
 }
})

test('a mixed-use Secret retains env/mount consumers and UID runtime without borrowing the TLS route',()=>{
 for(const label of ['envFrom','env','mount','projected mount']){
  const f=fixture(true)
  f.edges.push({from:'certificate',to:'bcontroller',label,family:'secret',componentIds:['b']})
  const trace=traceResource('certificate',f.edges,f.data)
  for(const id of ['aentry','bentry','bcontroller','bset','bpod'])assert.ok(trace.nodeIds.has(id),id)
  for(const id of ['aservice','acontroller','aset','apod','bservice','bregistry'])assert.ok(!trace.nodeIds.has(id),id)
 }
})

test('input flow rules follow relationship families for arbitrary resource names and consumers',()=>{
 for(const [role,family]of [['secret','secret'],['configmap','configuration'],['image','artifact']]){
  const data={opaque:{role},consumer:{role:'resource',kind:'UnknownConsumer'},child:{role:'pod'},other:{role:'resource'}}
  const edges=[{from:'opaque',to:'consumer',family,label:'input'}, {from:'consumer',to:'child',family:'control',label:'owns'}, {from:'consumer',to:'other',family:family==='configuration'?'secret':'configuration',label:'other flow'}]
  assert.deepEqual([...traceResource('opaque',edges,data).nodeIds].sort(),['opaque','consumer','child'].sort())
 }
})

test('columns respect arbitrary dependencies, preserve feasible preferences and survive real cycles',()=>{
 const preferred=new Map([['late-provider',4],['early-consumer',0],['end',5],['untouched',2]])
 const edges=[{from:'late-provider',to:'early-consumer'},{from:'early-consumer',to:'end'}]
 const columns=dependencyColumns(preferred,edges)
 for(const e of edges)assert.ok(columns.get(e.from)<columns.get(e.to))
 assert.equal(columns.get('untouched'),2)
 assert.deepEqual(dependencyColumns(new Map([...preferred].reverse()),[...edges].reverse()),columns)
 assert.deepEqual(dependencyColumns(preferred,[]),new Map([...preferred].sort(([a],[b])=>a.localeCompare(b))))
 const cycle=dependencyColumns(preferred,[...edges,{from:'early-consumer',to:'late-provider'}])
 assert.equal(cycle.get('early-consumer'),cycle.get('late-provider'))
 assert.ok(cycle.get('early-consumer')<cycle.get('end'))
})

const points=path=>[...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))
test('local and shared TLS dependencies run forward without map-wide reverse loops or card intersections',()=>{
 for(const shared of [false,true]){
  const f=fixture(shared),geometry=layoutResourceGraph(f.resources,f.edges,f.components),nodes=new Map(geometry.nodes.map(n=>[n.id,n]))
  for(const e of f.edges)assert.ok(nodes.get(e.from).x<nodes.get(e.to).x,JSON.stringify(e))
  for(const e of geometry.edges){
   const route=points(e.path)
   for(let i=1;i<route.length;i++)for(const n of geometry.nodes){
    const a=route[i-1],b=route[i],crosses=a.y===b.y?a.y>n.y&&a.y<n.y+H&&Math.min(a.x,b.x)<n.x+W&&Math.max(a.x,b.x)>n.x:a.x>n.x&&a.x<n.x+W&&Math.min(a.y,b.y)<n.y+H&&Math.max(a.y,b.y)>n.y
    assert.equal(crosses,false,`${e.id} intersects ${n.id}`)
   }
   if(e.id.includes('|TLS secret|')){
    assert.ok(nodes.get(e.to).x-nodes.get(e.from).x<=W+100,'TLS consumer stays in the next column')
    assert.ok(route.every((p,i)=>!i||p.x>=route[i-1].x),'TLS route never doubles back')
   }
  }
  assert.deepEqual(layoutResourceGraph([...f.resources].reverse(),[...f.edges].reverse(),[...f.components].reverse()),geometry)
 }
})
