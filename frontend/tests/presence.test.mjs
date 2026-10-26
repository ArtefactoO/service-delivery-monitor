import test from 'node:test'
import assert from 'node:assert/strict'
import {isPresent, presentEnvironments, presentInstances, archivedFeatures, aggregateHealth} from '../src/presence.ts'
import {argoTone} from '../src/data.ts'

const live = {id:'one',name:'one',environment:'test',source_ref:'dev',present:true,lifecycle:{},health:'Healthy',sync:'Synced'}
test('presence requires positive observation, excludes stopped and absent instances', () => {
  assert.equal(isPresent(live),true)
  assert.equal(isPresent({...live,present:undefined}),false)
  assert.equal(isPresent({...live,present:false}),false)
  assert.equal(isPresent({...live,lifecycle:{stopped_at:'2026-01-01'}}),false)
  assert.equal(isPresent({...live,observations:{test:{present:true,observed_at:'2026-01-01'}}}),true)
  assert.equal(isPresent({...live,observations:{test:{present:false,observed_at:'2026-01-02'},old:{present:true,observed_at:'2026-01-01'}}}),false)
})
test('environment selection uses only live branches in stable order, not array order', () => {
  const branches=[{...live,id:'z',name:'z',source_ref:'feature/z',environment:'feature'},
    {...live,id:'a',name:'a',source_ref:'feature/a',environment:'feature'},
    {...live,id:'old',environment:'feature',lifecycle:{stopped_at:'2026-01-01'}}, live]
  assert.deepEqual(presentInstances(branches,'feature').map(item=>item.id),['a','z'])
})
test('service environments require a present Application instead of configuration or a CI attempt', () => {
  const instances=[live, {...live,id:'config-only',environment:'prod',present:undefined,desired:{values_ref:'main'}},
    {...live,id:'absent',environment:'prod',present:false},
    {...live,id:'stopped',environment:'feature',lifecycle:{stopped_at:'2026-01-01'}},
    {...live,id:'feature',environment:'feature',health:'Degraded'},
    {...live,id:'duplicate',environment:'test'}]
  const before=structuredClone(instances)
  assert.deepEqual(presentEnvironments(instances,['prod','test','feature']),['test','feature'])
  assert.deepEqual(instances,before)
  const detail=instances.map(({present,...item})=>({...item,observations:present===undefined?{}:{argo:{present,observed_at:'2026-01-01'}}}))
  assert.deepEqual(presentEnvironments(detail,['prod','test','feature']),['test','feature'])
  assert.deepEqual(presentEnvironments([{...live,present:undefined}],['prod','test']),[])
})
test('service environment ordering preserves observations missing from publisher inventory', () => {
  const instances=[{...live,environment:'preprod'},live,{...live,environment:'prod',present:false}]
  assert.deepEqual(presentEnvironments(instances,['prod','test']),['test','preprod'])
  assert.deepEqual(presentEnvironments(instances),['preprod','test'])
})
test('multi-feature status reports errors and uncertainty instead of first-branch health', () => {
  assert.equal(aggregateHealth([live,{...live,health:'Degraded'}]).tone,'danger')
  assert.equal(aggregateHealth([live,{...live,sync:'OutOfSync'}]).tone,'warn')
  assert.equal(aggregateHealth([live,{...live,health:undefined}]).tone,'muted')
  assert.equal(aggregateHealth([live]).tone,'ok')
})
test('archive excludes alive and unconfirmed feature attempts; Argo drift cannot look healthy',()=>{
 const feature={...live,environment:'feature'}
 assert.deepEqual(archivedFeatures([feature,{...feature,id:'stopped',name:'stopped',lifecycle:{stopped_at:'2026-01-01'}},{...feature,id:'absent',name:'absent',present:false},{...feature,id:'unconfirmed',present:undefined}]).map(item=>item.id),['absent','stopped'])
 assert.equal(argoTone('OutOfSync','Healthy'),'warn')
 assert.equal(argoTone('Synced','Degraded'),'danger')
 assert.equal(argoTone('Synced','Healthy'),'ok')
 assert.equal(argoTone(undefined,'Healthy'),'muted')
})
