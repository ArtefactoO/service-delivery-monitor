import test from 'node:test'
import assert from 'node:assert/strict'
import {argoCheckedAt} from '../src/data.ts'
import {resourceProblem} from '../src/resource-presentation.ts'
import {evaluateFreshness} from '../src/freshness-policy.ts'

test('fresh Argo inventory and old runtime retain independent evidence and freshness',()=>{
 const now=Date.parse('2026-10-19T12:00:00Z'),inventory='2026-10-19T11:59:00Z',runtime='2026-10-19T10:00:00Z'
 const observation=Object.freeze({inventory_observed_at:inventory,observed_at:runtime,runtime:Object.freeze({observed_at:runtime})})
 assert.equal(argoCheckedAt(observation),inventory)
 assert.equal(evaluateFreshness({checkedAt:argoCheckedAt(observation),intervalSeconds:600},now).state,'fresh')
 assert.equal(evaluateFreshness({checkedAt:observation.runtime.observed_at,intervalSeconds:600},now).state,'stale')
 assert.equal(observation.observed_at,runtime)
 assert.equal(argoCheckedAt({observed_at:runtime}),runtime)
 assert.equal(argoCheckedAt({inventory_observed_at:null,observed_at:runtime}),runtime)
 assert.equal(argoCheckedAt(undefined),undefined)
})

test('reported problems remain visible for every resource role without inventing health',()=>{
 for(const role of ['pod','eso','secret','resource','workload','image','configmap','vault'])for(const tone of ['danger','warn']){
  const resource=Object.freeze({id:'opaque',role,kind:'ArbitraryKind',system:'kubernetes',fields:[['Evidence','Argo inventory'],['app reason','CrashLoopBackOff'],['init setup reason','ImagePullBackOff'],['other reason','CrashLoopBackOff'],['app last termination reason','OOMKilled']],status:{label:'Degraded',tone}})
  const problem=resourceProblem(resource)
  assert.equal(problem.status.label,'Argo: Degraded')
  assert.equal(problem.status.tone,tone)
  assert.deepEqual(problem.reasons,['CrashLoopBackOff','ImagePullBackOff'])
 }
 for(const status of [undefined,{label:'Healthy',tone:'ok'},{label:'Unknown',tone:'muted'},{label:'Last snapshot',tone:'muted'}])assert.equal(resourceProblem({system:'kubernetes',fields:[],status}),undefined)
})
