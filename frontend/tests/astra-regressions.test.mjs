import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {traceResource} from '../src/graph-selection.ts'
import {placeEdgeLabels} from '../src/graph-labels.ts'
import {requestGraphLayout} from '../src/graph-layout-controller.ts'
const ns='audit',id=(kind,name)=>`k8s:${ns}:${kind}:${name}`
const image=n=>({repository:'registry.example/image-'+n,digest:'sha256:'+String(n).repeat(64)})
const workload=(key,n=1,name)=>({key,name,kind:'Job',image:image(n),references:[],config_files:[],external_secret:{enabled:false,env_from:false,store:{},remote_refs:[]}})
const object=(kind,name,uid,extra={})=>({kind,name,namespace:ns,uid,owner_refs:[],parent_refs:[],resourceVersion:'1',...extra})
const inventory=(kind,name)=>({kind,name,namespace:ns,status:'Synced'})
function graph(resources,workloads,runtime={tree:[],objects:[]}){
 return resourceGraph({key:'app',project:'team/app',project_id:1,test_ref:'dev'},
  {name:'app',environment:'test',source_ref:'dev',lifecycle:{},observations:{test:{name:'app',namespace:ns,uid:'app',present:true,observed_at:'2026-10-19T12:00:00Z',chart_repo:'https://git.example/team/service-chart.git',resources,git:{source_revision:'a'.repeat(40),images:workloads.map(w=>w.image),workloads},runtime}}},{argo:{test:'https://argo.example'}})
}
test('Job matching rejects prefix neighbours, malformed hashes and bidirectional ambiguity',()=>{
 for(const name of ['app-migrate-data-012345abcdef','app-migrate-data-012345abcde','app-migrate-data-012345abcdef0']){
  const g=graph([inventory('Job',name)],[workload('migrate',1),workload('migrate-data',2)])
  const edges=g.relationships.filter(e=>e.label==='desired image')
  assert.deepEqual(edges.map(e=>e.from),name.endsWith('-012345abcdef')?['image:registry.example/image-2']:[])
 }
 const named='app-migrate-012345abcdef'
 const ambiguous=graph([inventory('Job',named)],[workload('migrate',1),workload('explicit',2,named)])
 assert.equal(ambiguous.relationships.filter(e=>e.label==='desired image').length,0)
 const two=graph([inventory('Job','app-migrate-012345abcdef'),inventory('Job','app-migrate-abcdef012345')],[workload('migrate')])
 assert.equal(two.relationships.filter(e=>e.label==='desired image').length,0)
 const exact=graph([inventory('Job','custom-name')],[workload('explicit',1,'custom-name')])
 assert.equal(exact.relationships.filter(e=>e.label==='desired image').length,1)
})
test('Service selects actual matching Pods independently of template matches and rollout ownership',()=>{
 const dep=object('Deployment','app-api','dep',{pod_labels:{app:'new'},status:{}}),rs=object('ReplicaSet','old-set','rs',{owner_refs:[{uid:'dep',kind:'Deployment',name:'app-api',controller:true}]}),old=object('Pod','old-pod','old',{pod_labels:{app:'old'},owner_refs:[{uid:'rs',kind:'ReplicaSet',name:'old-set',controller:true}],images:[],containers:[]}),matching=object('Pod','matching-pod','match',{pod_labels:{app:'new'},images:[],containers:[]}),foreign={...matching,name:'foreign',uid:'foreign',namespace:'other'},svc=object('Service','front','svc',{selector:{app:'new'}})
 const g=graph([inventory('Deployment','app-api'),inventory('Service','front')],[{...workload('api'),kind:'Deployment'}],{observed_at:'2026-10-19T12:00:00Z',tree:[dep,rs,old,matching,foreign,svc].map(o=>({...o,parent_refs:o.owner_refs})),objects:[dep,old,matching,foreign,svc]})
 const trace=traceResource(id('Service','front'),g.relationships,g.data)
 assert.ok(g.relationships.some(e=>e.from===id('Service','front')&&e.to===id('Pod','matching-pod')&&e.label==='selects'))
 assert.ok(g.relationships.some(e=>e.from===id('Service','front')&&e.to===id('Deployment','app-api')&&e.label==='matches template'))
 assert.ok(trace.nodeIds.has(id('Pod','matching-pod')))
 assert.ok(!trace.nodeIds.has(id('Pod','old-pod')))
 assert.ok(![...trace.nodeIds].some(id=>id.includes('foreign')))
 const controller=traceResource(id('Deployment','app-api'),g.relationships,g.data)
 assert.ok(controller.nodeIds.has(id('Pod','old-pod')),'controller retains its real old rollout')
})
test('identical captions cannot hide independent routes with the same relation text',()=>{
 const edges=[{id:'a',from:'one',to:'two',path:'M 0 100 L 300 100',labelX:150,labelY:86},{id:'b',from:'three',to:'four',path:'M 150 0 L 150 200',labelX:150,labelY:50}]
 const labels=placeEdgeLabels(edges,[],[],new Map([['a','envFrom'],['b','envFrom']]),224,116)
 for(const label of labels){
  const box={x:label.labelX-label.labelWidth/2,y:label.labelY-label.labelHeight/2,width:label.labelWidth,height:label.labelHeight}
  for(const edge of edges.filter(e=>e.id!==label.id)){
   const ps=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))
   for(let i=1;i<ps.length;i++){
    const a=ps[i-1],b=ps[i],hit=a.y===b.y?a.y>box.y&&a.y<box.y+box.height&&Math.min(a.x,b.x)<box.x+box.width&&Math.max(a.x,b.x)>box.x:a.x>box.x&&a.x<box.x+box.width&&Math.min(a.y,b.y)<box.y+box.height&&Math.max(a.y,b.y)>box.y
    assert.equal(hit,false)
   }
  }
 }
})
test('worker cancellation rejects late geometry and failures remain retryable without sync fallback',()=>{
 const workers=[],results=[],errors=[]
 const create=()=>{const w={onmessage:null,onerror:null,postMessage(value){this.input=value},terminate(){this.closed=true}};workers.push(w);return w}
 const cancel=requestGraphLayout('old',create,g=>results.push(g),()=>errors.push('old'))
 cancel();workers[0].onmessage({data:{geometry:{old:true}}});assert.deepEqual(results,[])
 requestGraphLayout('new',create,g=>results.push(g),()=>errors.push('new'))
 workers[1].onmessage({data:{geometry:{new:true}}});assert.deepEqual(results,[{new:true}]);assert.equal(workers[1].closed,true)
 requestGraphLayout('failure',create,g=>results.push(g),()=>errors.push('worker'))
 workers[2].onerror({});workers[2].onmessage({data:{geometry:{late:true}}});assert.deepEqual(errors,['worker']);assert.equal(results.length,1)
 requestGraphLayout('unsupported',()=>{throw Error('Worker unavailable')},()=>assert.fail(),()=>errors.push('unsupported'))
 assert.deepEqual(errors,['worker','unsupported'])
})
