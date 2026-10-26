import test from 'node:test'
import assert from 'node:assert/strict'
import {ciHeaderContext,compareAttemptImages,publicationProvenance} from '../src/ci-status-data.ts'

const registration={key:'sample',project:'team/sample',project_id:1,test_ref:'dev'}
const links={gitlab:'https://git.example',deployments:'https://git.example/platform/deployments.git',argo:{}}
const image=(digest='a',repository='registry.example/app')=>({repository,digest:'sha256:'+digest.repeat(64)})
const observation=(images=[image()])=>({present:true,sync:'Synced',health:'Healthy',observed_at:'2026-10-19T12:00:00Z',git:{images,build_job:'10',build_pipeline:'9',publisher_pipeline:'20',build_revision:'a'.repeat(40)}})
const instance=(environment='prod',name='sample',ref='dev',obs=observation())=>({name,environment,source_ref:ref,lifecycle:{},observations:{argo:obs}})
const attempt=(kind,job,environment,instance='sample',ref='dev',images=[image('b')])=>({key:kind+job,received_at:job,payload:{kind,status:'succeeded',source:{ref,revision:'b'.repeat(40)},images,attempt:{pipeline_id:job,job_id:job},...(environment?{target:{environment,instance}}:{})}})

test('an older prod publication stays separate from a newer build and test delivery on the same branch',()=>{
 const attempts=[attempt('build',99),attempt('publication',100,'test'),attempt('deployment',100,'test')],saved=structuredClone(attempts)
 const context=ciHeaderContext({latest_attempts:attempts},registration,instance(),'prod')
 assert.equal(context.build.attempt.job_id,99)
 assert.equal(context.publication,undefined)
 assert.equal(context.deployment,undefined)
 assert.equal(context.imageComparison,'different')
 assert.deepEqual(publicationProvenance(registration,context.observation,links),[
  {label:'Build #10',href:'https://git.example/team/sample/-/jobs/10'},
  {label:'Publisher pipeline #20',href:'https://git.example/platform/deployments/-/pipelines/20'},
 ])
 assert.deepEqual(attempts,saved)
})

test('environment and feature instance both scope publication/deployment receipts',()=>{
 const selected=instance('feature','feature-one','feature/same'),attempts=[attempt('build',11,undefined,undefined,'feature/same'),attempt('publication',12,'feature','feature-one','feature/same'),attempt('deployment',13,'feature','feature-one','feature/same'),attempt('publication',99,'feature','feature-two','feature/same'),attempt('deployment',100,'prod','feature-one','feature/same')]
 const context=ciHeaderContext({latest_attempts:attempts},registration,selected,'feature')
 assert.equal(context.build.attempt.job_id,11)
 assert.equal(context.publication.attempt.job_id,12)
 assert.equal(context.deployment.attempt.job_id,13)
})

test('image identity does not change just because build SHA changes or image order differs',()=>{
 const original=[image('a'),image('b','registry.example/worker')],built=attempt('build',99,undefined,undefined,'dev',[original[1],original[0]]).payload
 assert.equal(compareAttemptImages(built,observation(original)),'same')
})

test('missing/partial image metadata never claims a match or a different deployed image',()=>{
 assert.equal(compareAttemptImages(attempt('build',1,undefined,undefined,'dev',[]).payload,observation()),undefined)
 assert.equal(compareAttemptImages(attempt('build',1).payload,undefined),undefined)
 assert.equal(compareAttemptImages(attempt('build',1,undefined,undefined,'dev',[image()]).payload,observation([image(),image('c','registry.example/worker')])),undefined)
})

test('Argo health never invents CI receipts; inactive snapshots retain only provenance',()=>{
 const selected=instance();selected.lifecycle.stopped_at='2026-10-19T12:00:00Z'
 const context=ciHeaderContext({},registration,selected,'prod')
 assert.equal(context.inactive,true)
 assert.equal(context.build,undefined)
 assert.equal(context.publication,undefined)
 assert.equal(context.deployment,undefined)
 assert.ok(publicationProvenance(registration,context.observation,links).length)
})

test('unknown build refs do not select an arbitrary successful branch build',()=>{
 const context=ciHeaderContext({latest_attempts:[attempt('build',99)]},{...registration,test_ref:null},undefined,'prod')
 assert.equal(context.build,undefined)
})

test('invalid provenance IDs cannot create job links and absent metadata stays absent',()=>{
 const obs=observation();obs.git={images:[],build_job:'not-a-job',publisher_pipeline:'https://foreign.example'}
 assert.deepEqual(publicationProvenance(registration,obs,links),[])
})
