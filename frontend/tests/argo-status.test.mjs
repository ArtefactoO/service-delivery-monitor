import test from 'node:test'
import assert from 'node:assert/strict'
import {argoResourceStatus} from '../src/argo-status.ts'
import {enrichRuntime} from '../src/runtime-data.ts'

const key=(kind,name)=>`k8s:sample:${kind}:${name}`
test('Argo observations are authoritative and Synced alone is not readiness',()=>{
 assert.deepEqual(argoResourceStatus('Synced'),{label:'Synced',tone:'muted'})
 assert.deepEqual(argoResourceStatus('OutOfSync','Healthy'),{label:'OutOfSync · Healthy',tone:'warn'})
 assert.equal(argoResourceStatus('Synced','Missing').tone,'danger')
 assert.equal(argoResourceStatus('Synced','Suspended').tone,'muted')
 assert.equal(argoResourceStatus(undefined,undefined).label,'Unknown')
})
test('runtime counts and conditions cannot override Argo health or imply secret observation',()=>{
 const data={},edges=[]
 const runtime={application_uid:'app',observed_at:'2026-10-16T12:00:00Z',truncated:false,tree:[
  {uid:'dep',kind:'Deployment',name:'api',namespace:'sample',health:'Progressing',parent_refs:[]},
  {uid:'pod',kind:'Pod',name:'api-pod',namespace:'sample',health:'Degraded',parent_refs:[{uid:'dep',kind:'Deployment',name:'api'}]},
  {uid:'eso',kind:'ExternalSecret',name:'runtime',namespace:'sample',health:'Healthy',parent_refs:[]},
  {uid:'job',kind:'Job',name:'migrate',namespace:'sample',health:'Progressing',parent_refs:[]}],objects:[
   {uid:'dep',kind:'Deployment',name:'api',namespace:'sample',owner_refs:[],desired_replicas:3,generation:2,status:{readyReplicas:3,updatedReplicas:1,availableReplicas:2,observedGeneration:2}},
   {uid:'pod',kind:'Pod',name:'api-pod',namespace:'sample',owner_refs:[{uid:'dep',kind:'Deployment',name:'api'}],deleting:true,phase:'Running',conditions:[{type:'Ready',status:'False'}],images:[{name:'app',image:'registry.example/app@sha256:1'}],containers:[{name:'app',ready:true,restarts:4,state:'waiting',reason:'CrashLoopBackOff'}],references:[{kind:'Secret',name:'runtime',relation:'envFrom'}]},
   {uid:'job',kind:'Job',name:'migrate',namespace:'sample',owner_refs:[],status:{succeeded:1,conditions:[{type:'Complete',status:'True'}]}}]}
 enrichRuntime(data,edges,runtime,undefined,600)
 assert.deepEqual(data[key('Deployment','api')].status,{label:'Progressing',tone:'warn'})
 assert.equal(data[key('Deployment','api')].fields.find(([name])=>name==='Ready replicas')[1],'3')
 assert.deepEqual(data[key('Pod','api-pod')].status,{label:'Degraded',tone:'danger'})
 assert.ok(data[key('Pod','api-pod')].fields.some(([name,value])=>name==='app reason'&&value==='CrashLoopBackOff'))
 assert.equal(data[key('ExternalSecret','runtime')].status.label,'Healthy')
 assert.equal(data[key('Job','migrate')].status.label,'Progressing')
 assert.equal(data[key('Secret','runtime')].status.label,'Referenced')
 assert.equal(data[key('Secret','runtime')].freshness,undefined)
 assert.equal(data[key('Secret','runtime')].fields.find(([name])=>name==='Evidence')[1],'Kubernetes spec reference')
 assert.equal(data[key('ExternalSecret','runtime')].freshness.checkedAt,runtime.observed_at)
})
