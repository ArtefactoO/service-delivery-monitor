import test from 'node:test'
import assert from 'node:assert/strict'
import {historicalSnapshot,latest,resourceGraph} from '../src/data.ts'
import {archivedFeatures,isPresent,presentEnvironments} from '../src/presence.ts'
import {ciHeaderContext} from '../src/ci-status-data.ts'

const oldUid='11111111-1111-4111-8111-111111111111',newUid='22222222-2222-4222-8222-222222222222'
const service={key:'sample',project:'team/sample',project_id:1,test_ref:'dev',instances:[]}
const observation={name:'branch-instance',uid:oldUid,namespace:'feature-ns',project:'services',present:true,
 sync:'Synced',health:'Healthy',observed_at:'2026-01-02T10:00:00Z',values_ref:'main',values_path:'kubernetes/feature/branch-instance/values.yaml',
 values_revision:'a'.repeat(40),resources:[{kind:'Deployment',name:'branch-instance-api',namespace:'feature-ns',health:'Healthy',status:'Synced'}],
 git:{source_revision:'a'.repeat(40),images:[],workloads:[{key:'api',name:'branch-instance-api',kind:'Deployment',config_files:[],config_mounts:[],references:[],external_secret:{enabled:false}}]}}
const instance={id:'sample:feature:branch-instance',name:'branch-instance',environment:'feature',source_ref:'feature/topic',
 lifecycle:{application_uid:newUid,created_at:'2026-01-02T10:10:00Z'},observations:{argo:observation}}
const links={gitlab:'https://git.example',argo:{argo:'https://argo.example'},deployments:'https://git.example/deployments'}

test('new UID cannot reuse a stopped incarnation as a live environment or map',()=>{
 const before=structuredClone(instance)
 assert.equal(isPresent(instance),false)
 assert.equal(isPresent({environment:'feature',lifecycle:instance.lifecycle,present:true,observation_uid:oldUid}),false)
 assert.deepEqual(presentEnvironments([instance],['test','feature']),[])
 assert.deepEqual(archivedFeatures([instance]).map(i=>i.id),[instance.id])
 assert.equal(historicalSnapshot(instance),true)
 const graph=resourceGraph(service,instance,links)
 assert.ok(Object.values(graph.data).filter(r=>r.system==='kubernetes').length)
 for(const resource of Object.values(graph.data).filter(r=>r.system==='kubernetes'||r.role==='argo')){
  assert.deepEqual(resource.status,{label:'Last snapshot',tone:'muted'})
  assert.equal(resource.freshness?.inactive,true)
 }
 assert.match(graph.data.argo.description,/предыдущего Application/)
 assert.equal(ciHeaderContext({latest_attempts:[]},service,instance,'feature').inactive,true)
 assert.deepEqual(instance,before)
})

test('matching Argo UID makes the new incarnation live and takes precedence over older identities',()=>{
 const current={...instance,observations:{...instance.observations,current:{...observation,uid:newUid},
  delayed:{...observation,observed_at:'2026-01-02T10:20:00Z'}}}
 assert.equal(latest(current)[1].uid,newUid)
 assert.equal(isPresent(current),true)
 assert.deepEqual(presentEnvironments([current]),['feature'])
 assert.deepEqual(archivedFeatures([current]),[])
 assert.equal(historicalSnapshot(current),false)
 assert.equal(resourceGraph(service,current,links).data.argo.status.tone,'ok')
 assert.equal(ciHeaderContext({latest_attempts:[]},service,current,'feature').inactive,false)
})
