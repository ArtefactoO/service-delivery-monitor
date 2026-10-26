import test from 'node:test'
import assert from 'node:assert/strict'
import {featureSchedule,featureSelectionLabel,featureUptimeSeconds} from '../src/feature-context.ts'
import {ciAttemptDetails,serviceHistoryHref} from '../src/activity-context.ts'

const at=Date.parse('2026-10-16T10:00:00Z')
test('duplicate feature branches retain distinct instance hints even when their eight-character suffixes collide',()=>{
 const choices=[{name:'ft-sample-one-a-12345678',source_ref:'feature/topic'},{name:'ft-sample-two-b-12345678',source_ref:'feature/topic'}]
 const first=featureSelectionLabel(choices[0],choices),second=featureSelectionLabel(choices[1],choices)
 assert.equal(first.branch,'feature/topic')
 assert.notEqual(first.hint,second.hint)
 assert.ok(first.hint.length<choices[0].name.length)
 assert.ok(first.tooltip.includes(choices[0].name))
 assert.equal(featureSelectionLabel(choices[0],[choices[0]]).hint,undefined)
 assert.equal(featureSelectionLabel(choices[0],[choices[0],{...choices[1],source_ref:'feature/another'}]).hint,undefined)
})

test('feature uptime follows the common clock but stops at the confirmed stop, including archived snapshots',()=>{
 const instance={lifecycle:{created_at:'2026-10-16T09:00:00Z'},lifetime_seconds:3600}
 assert.equal(featureUptimeSeconds(instance,at+60000),3660)
 const stopped={...instance,lifecycle:{...instance.lifecycle,stopped_at:'2026-10-16T09:30:00Z'}}
 assert.equal(featureUptimeSeconds(stopped,at+86400000),1800)
 assert.equal(featureUptimeSeconds({...instance,lifetime_seconds:null},at),undefined)
 assert.equal(featureUptimeSeconds({lifecycle:{created_at:'invalid'}},at),undefined)
})

test('auto-stop countdown and overdue state follow an explicit deadline and do not assert resource health',()=>{
 const life={auto_stop_at:'2026-10-16T10:30:00Z'}
 assert.deepEqual(featureSchedule(life,at),{kind:'scheduled',at:at+1800000,seconds:1800})
 assert.deepEqual(featureSchedule(life,at+2700000),{kind:'overdue',at:at+1800000,seconds:900})
 assert.equal(featureSchedule(life,at+1800000).kind,'overdue')
 assert.equal(featureSchedule({},at),undefined)
 assert.equal(featureSchedule({auto_stop_at:'invalid'},at),undefined)
})

test('archives show a real stop and never turn an old planned deadline into an assumed stop',()=>{
 const life={auto_stop_at:'2026-10-16T09:00:00Z'}
 assert.equal(featureSchedule(life,at,true),undefined)
 const stopped={...life,stopped_at:'2026-10-16T09:15:00Z'}
 assert.deepEqual(featureSchedule(stopped,at,true),{kind:'stopped',at:Date.parse(stopped.stopped_at)})
 assert.equal(featureSchedule({stopped_at:'invalid'},at,true),undefined)
})

test('history deep links preserve exact archived context without needing a live catalog entry',()=>{
 const url=new URL(serviceHistoryHref('removed-service','feature','ft-old-instance'),'https://sdm.example')
 assert.equal(url.pathname,'/')
 assert.deepEqual(Object.fromEntries(url.searchParams),{page:'service',service:'removed-service',tab:'history',env:'feature',instance:'ft-old-instance'})
 const branchLike='old/instance?value#part'
 assert.equal(new URL(serviceHistoryHref('service with spaces','preprod',branchLike),'https://sdm.example').searchParams.get('instance'),branchLike)
 const serviceOnly=new URL(serviceHistoryHref('sample'),'https://sdm.example')
 assert.equal(serviceOnly.searchParams.has('instance'),false)
 assert.equal(serviceOnly.searchParams.has('env'),false)
})

test('CI attempt details identify event time and source revisions without substituting current Argo health',()=>{
 const payload={status:'failed',occurred_at:'2026-10-16T09:00:00Z',source:{ref:'feature/topic',revision:'a'.repeat(40)},attempt:{pipeline_id:10,job_id:20},failure_code:'build_failed',publication:{revision:'b'.repeat(40)}}
 const observation={health:'Healthy',git:{source_revision:'c'.repeat(40),build_revision:'d'.repeat(40)}}
 const details=ciAttemptDetails(payload,observation)
 assert.match(details,/Время события CI:/)
 for(const revision of ['a','b','c','d'])assert.ok(details.includes(revision.repeat(40)))
 assert.match(details,/Код результата CI: build_failed/)
 assert.match(details,/не заменяет текущий Health Argo/)
 assert.doesNotMatch(details,/Healthy/)
 assert.match(ciAttemptDetails({...payload,occurred_at:undefined}),/Время события CI не передано/)
 assert.doesNotMatch(ciAttemptDetails(payload),/Build revision image/)
})
