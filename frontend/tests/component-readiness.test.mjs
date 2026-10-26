import test from 'node:test'
import assert from 'node:assert/strict'
import {componentReadiness,workloadCount} from '../src/component-readiness.ts'
import {resourceFields} from '../src/resource-presentation.ts'

const controller=(ready,target,extra={})=>({kind:'Deployment',fields:[['Ready replicas',ready],['Target replicas',target],['Pod restarts','2']].filter(([,value])=>value!==undefined),...extra})
test('replica readiness separates partial, missing, zero-scale and unknown counts without changing Argo health',()=>{
 for(const [ready,target,tone] of [['3','3','ok'],['1','3','warn'],['0','3','danger'],['0','0','muted'],['1','0','warn'],[undefined,'2','muted'],['unknown','2','muted'],['1.5','2','muted'],['-1','2','muted']]){
  const resource=controller(ready,target,{status:{label:'Argo: Healthy',tone:'ok'}}),before=structuredClone(resource)
  assert.equal(componentReadiness([resource]).tone,tone)
  assert.deepEqual(resource,before)
 }
 assert.equal(componentReadiness([controller('0','0')]).label,'0 / 0 · scaled to zero')
 assert.equal(componentReadiness([controller('1','0')]).label,'1 / 0 Ready')
 assert.equal(componentReadiness([]).label,'Не подтверждено')
})
test('every controller must provide counts before a component total is reported',()=>{
 assert.equal(componentReadiness([controller('1','2'),controller('2','2')]).label,'3 / 4 Ready')
 assert.equal(workloadCount([controller('1','2'),controller('2','2')],'Pod restarts'),4)
 assert.equal(componentReadiness([controller('1','2'),controller(undefined,'2')]).label,'Не подтверждено')
 assert.equal(workloadCount([controller('1','2'),controller('1','2',{fields:[]})],'Pod restarts'),undefined)
 assert.equal(componentReadiness([controller('1','1',{status:{label:'Last snapshot',tone:'muted'}})]).label,'Последний снимок')
})
test('Job results remain independent from replica readiness',()=>{
 const job=fields=>({kind:'Job',fields})
 assert.equal(componentReadiness([job([['Succeeded Jobs','1'],['Active Jobs','0'],['Failed Jobs','0']])]).tone,'ok')
 assert.equal(componentReadiness([job([['Succeeded Jobs','1'],['Failed Jobs','1']])]).tone,'danger')
 assert.equal(componentReadiness([job([['Active Jobs','2']])]).label,'2 active')
 assert.equal(componentReadiness([job([])]).label,'Не подтверждено')
 assert.equal(componentReadiness([controller('1','1'),job([['Succeeded Jobs','1']])]).tone,'muted')
})
test('technical view preserves every nonempty field, including future keys and duplicated field names',()=>{
 for(const role of ['repo','argo','image','workload','pod','secret','configmap','resource']){
  const resource={role,kind:'Deployment',system:'kubernetes',componentIds:['component:opaque'],status:{label:'Synced · Healthy',tone:'ok'},fields:[['Branch','feature/topic'],['Sync','Synced'],['Health','Healthy'],['Ready replicas','1'],['Target replicas','1'],['Unknown future field','value'],['Unknown future field','second value'],['Empty','']]}
  const before=structuredClone(resource),view=resourceFields(resource,'technical')
  assert.deepEqual([...view.primary,...Object.values(view.additional).flat()].sort(),resource.fields.filter(([,value])=>value).sort())
  assert.deepEqual(resource,before)
 }
})
