import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {enrichNetwork} from '../src/network-data.ts'
import {buildHistory} from '../src/history-data.ts'
import {nodeInViewport} from '../src/graph-viewport.ts'
import {layoutResourceGraph,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT} from '../src/graph-layout.ts'
import {edgeLabelGroups} from '../src/graph-labels.ts'

function graph(stores,repository='registry.example.com/team/app',bindings={}){
 const image={repository,digest:'sha256:'+'a'.repeat(64)}
 const workloads=stores.map((store,index)=>({key:'app'+index,kind:'Deployment',image,config_files:[],references:[],external_secret:{enabled:true,env_from:true,store,remote_refs:[{key:'same/path',mode:'extract'}]}}))
 return resourceGraph({key:'sample',project:'team/sample',project_id:1,test_ref:'dev',team:null,instances:[]},
  {name:'sample',environment:'test',source_ref:'dev',lifecycle:{},observations:{test:{name:'sample',namespace:'sample',uid:'app',present:true,sync:'Synced',health:'Healthy',observed_at:'2026-01-01T00:00:00Z',chart_repo:'https://git.example/service-chart.git',values_revision:'b'.repeat(40),values_ref:'main',resources:workloads.map(workload=>({kind:workload.kind,name:'sample-'+workload.key,namespace:'sample',status:'Synced'})),git:{images:[image],source_ref:'dev',source_revision:'c'.repeat(40),workloads}}}},
  {gitlab:'https://git.example',deployments:'https://git.example/deployments.git',argo:{test:'https://argo.example'},vault_stores:bindings})
}
test('Vault store kind and namespace cannot borrow an ambiguous legacy binding',()=>{
 const result=graph([{name:'same',kind:'SecretStore'},{name:'same',kind:'ClusterSecretStore'}],undefined,{same:{url:'https://vault.example',mount:'cluster'}})
 const nodes=Object.values(result.data).filter(resource=>resource.role==='vault')
 assert.equal(nodes.length,2)
 assert.equal(new Set(nodes.map(node=>node.identity)).size,2)
 assert.ok(nodes.every(node=>!node.url))
 assert.ok(nodes.every(node=>result.relationships.filter(edge=>edge.from===node.id).length===1))
 const explicit=graph([{name:'same',kind:'SecretStore'}],undefined,{'SecretStore:sample:same':{url:'https://vault.example',mount:'namespace'}})
 assert.match(Object.values(explicit.data).find(node=>node.role==='vault').url,/namespace\/kv/)
 const compatible=graph([{name:'same'}],undefined,{same:{url:'https://vault.example',mount:'cluster'}})
 assert.match(compatible.data['vault:same:same/path'].url,/cluster\/kv/)
})
test('bare and third party image references retain names and do not claim Nexus',()=>{
 for(const repository of ['ubuntu','library/ubuntu','ghcr.io/team/app','registry.example.com/team/app']){
  const resource=Object.values(graph([],repository).data).find(node=>node.role==='image')
  assert.ok(resource.title)
  assert.equal(resource.system,repository.startsWith('registry.example.com/')?'nexus':'registry')
  assert.equal(resource.identity,repository+'@sha256:'+'a'.repeat(64))
 }
})
test('Ingress TLS references remain unverified core Secrets without Secret GET',()=>{
 const ingress={id:'k8s:sample:Ingress:entry',role:'resource',kind:'Ingress',title:'entry',fields:[]},data={[ingress.id]:ingress},edges=[]
 enrichNetwork(data,edges,{objects:[{kind:'Ingress',name:'entry',namespace:'sample',routes:[],tls_secrets:['app-tls']}]})
 const secret=data['k8s:sample:Secret:app-tls']
 assert.equal(secret.role,'secret');assert.equal(secret.status.label,'Referenced')
 assert.ok(edges.some(edge=>edge.from===secret.id&&edge.to===ingress.id&&edge.label==='TLS secret'&&edge.family==='secret'))
 assert.equal(secret.fields.find(([key])=>key==='Health'),undefined)
})
test('recovery classification is stable across pages when the backend supplies context',()=>{
 const healthy={id:2,service:'sample',kind:'argocd_notification',received_at:100,previous_health:'Degraded',payload:{event:'health_changed',source:'test',application:'sample',application_uid:'uid',environment:'test',source_ref:'dev',health:'Healthy',sync:'Synced',health_changed_at:'2026-01-02T00:00:00Z'}}
 const degraded={...healthy,id:1,previous_health:null,payload:{...healthy.payload,health:'Degraded',health_changed_at:'2026-01-01T00:00:00Z'}}
 const first=buildHistory([healthy]).operations.find(row=>row.events[0].id===2)
 assert.equal(first.title,'Приложение восстановилось')
 assert.deepEqual(buildHistory([healthy,degraded]).operations.find(row=>row.events[0].id===2),first)
 assert.equal(buildHistory([{...healthy,previous_health:null}]).operations.length,0)
})
test('only fully visible cards outside the minimap enter sequential keyboard focus',()=>{
 const size={width:900,height:600},view={x:0,y:0,zoom:1}
 assert.equal(nodeInViewport({x:20,y:20},GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,view,size),true)
 assert.equal(nodeInViewport({x:20,y:-30},GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,view,size),false)
 assert.equal(nodeInViewport({x:20,y:700},GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,view,size),false)
 assert.equal(nodeInViewport({x:650,y:460},GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,view,size),false)
})
test('an adjacent shared-resource wire stays local even when its caption is long',()=>{
 const resources=['repo','config','sourceValues','chart','values','argo'].map(id=>({id,role:id,kind:id}))
 const relationships=[['config','values','config files'],['sourceValues','values','merge'],['chart','argo','chart source'],['values','argo','Git source']].map(([from,to,label])=>({from,to,label,family:'configuration'}))
 const graph=layoutResourceGraph(resources,relationships,[])
 for(const edge of graph.edges.filter(edge=>['sourceValues','chart','values'].includes(edge.from))){
  const points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))
  const distance=points.slice(1).reduce((total,point,index)=>total+Math.abs(point.x-points[index].x)+Math.abs(point.y-points[index].y),0)
  const from=points[0],to=points.at(-1)
  assert.ok(distance<=Math.abs(from.x-to.x)+Math.abs(from.y-to.y)+32,edge.id+' takes an unnecessary detour')
 }
})
test('large Argo fanout keeps every connection port on the source and target card',()=>{
 const resources=[{id:'repo',role:'repo',kind:'Source code'},{id:'argo',role:'argo',kind:'Argo Application'},...Array.from({length:160},(_,index)=>({id:'object-'+index,role:'resource',kind:'Custom'}))]
 const relations=resources.filter(resource=>resource.id.startsWith('object-')).map(resource=>({from:'argo',to:resource.id,label:'manages',family:'control'}))
 const graph=layoutResourceGraph(resources,relations,[]),nodes=new Map(graph.nodes.map(node=>[node.id,node]))
 for(const edge of graph.edges){
  const points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))
  assert.ok(points[0].y>=nodes.get(edge.from).y&&points[0].y<=nodes.get(edge.from).y+GRAPH_NODE_HEIGHT)
  assert.ok(points.at(-1).y>=nodes.get(edge.to).y&&points.at(-1).y<=nodes.get(edge.to).y+GRAPH_NODE_HEIGHT)
 }
})
test('a shared caption keeps one stable owner while individual edges remain distinct',()=>{
 const first={id:'a',labelText:'envFrom',labelX:100,labelY:50},second={...first,id:'b'},other={...first,id:'c',labelX:150}
 const groups=edgeLabelGroups([first,second,other])
 assert.deepEqual(groups.get('a'),['a','b'])
 assert.equal(groups.get('a'),groups.get('b'))
 assert.deepEqual(groups.get('c'),['c'])
})
