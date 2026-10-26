import test from 'node:test'
import assert from 'node:assert/strict'
import {buildHistory,eventLabel,eventTime,formatDuration,hasEventTime,historyLinks,historyTimings,scopeHistory} from '../src/history-data.ts'
const time=n=>`2026-10-16T10:00:${String(n).padStart(2,'0')}Z`
const ci=(id,kind,status,n,extra={})=>({id,service:'sample',kind,received_at:Date.parse(time(50))/1000,applied:true,payload:{status,occurred_at:time(n),source:{ref:'dev',revision:'a'.repeat(40)},target:{environment:'test',instance:'sample'},attempt:{project_id:443,pipeline_id:30,job_id:300},publication:{revision:'b'.repeat(40)},...extra}})
const argo=(id,event,n,extra={})=>({id,service:'sample',kind:'argocd_notification',received_at:Date.parse(time(40))/1000,applied:false,payload:{source:'argo-test',event,project:'services',application:'sample',application_uid:'uid',environment:'test',source_project:'team/sample',source_ref:'dev',sync:'Synced',health:'Healthy',revisions:['b'.repeat(40)],operation_started_at:time(12),operation_finished_at:time(n),health_changed_at:time(n),...extra}})
test('publication and deployment stages collapse by issuer job, links use the owning repository',()=>{
 const items=[ci(1,'publication','started',1),ci(2,'publication','succeeded',10),ci(3,'deployment','started',11),ci(4,'deployment','succeeded',30,{runtime:{application_uid:'uid',verified_at:time(30)}}),argo(5,'sync_running',12),argo(6,'sync_succeeded',20)]
 const result=buildHistory(items.reverse())
 assert.equal(result.operations.length,1)
 assert.equal(result.operations[0].events.length,6)
 assert.equal(result.operations[0].title,'Выкат подтвержден')
 assert.deepEqual(result.operations[0].events.map(item=>item.id),[1,2,3,5,6,4])
 const links={gitlab:'https://git.example',deployments:'https://git.example/infra/deployments.git',argo:{'argo-test':'https://argo.example'}}
 assert.equal(historyLinks(items.find(e=>e.id===4),[],links)[0].url,'https://git.example/infra/deployments/-/jobs/300')
 assert.equal(historyLinks(items.find(e=>e.id===4),[],links)[1].url,'https://git.example/infra/deployments/-/pipelines/30')
 const build=ci(8,'build','succeeded',1,{attempt:{project_id:123,pipeline_id:10,job_id:100}})
 assert.equal(historyLinks(build,[{key:'sample',project:'team/sample',project_id:123}],links)[0].url,'https://git.example/team/sample/-/jobs/100')
})
test('sync running is not shown as healthy even when the application health is Healthy',()=>{
 const row=buildHistory([argo(1,'sync_running',10)]).operations[0]
 assert.equal(row.tone,'warn');assert.equal(row.status,'Выполняется')
})
test('ambiguous Argo sync stays independent for every receipt order without rewriting inputs',()=>{
 const attempt=job=>({project_id:443,pipeline_id:job,job_id:job})
 const events=[ci(1,'publication','succeeded',5,{attempt:attempt(100)}),ci(2,'deployment','succeeded',40,{attempt:attempt(100),runtime:{application_uid:'uid',verified_at:time(40)}}),ci(3,'publication','succeeded',10,{attempt:attempt(200)}),ci(4,'deployment','succeeded',40,{attempt:attempt(200),runtime:{application_uid:'uid',verified_at:time(40)}}),argo(5,'sync_succeeded',30,{operation_started_at:time(20)})]
 const before=JSON.stringify(events)
 const permutations=values=>values.length?values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[v,...rest])):[[]]
 const expected=buildHistory(events)
 for(const order of permutations(events)){
  const result=buildHistory(order)
  assert.deepEqual(result,expected)
  assert.equal(result.operations.length,3)
  assert.deepEqual(result.operations.find(op=>op.kind==='argo').events.map(e=>e.id),[5])
  assert.ok(result.operations.filter(op=>op.kind==='delivery').every(op=>op.events.every(e=>!('event'in e.payload))))
 }
 assert.equal(JSON.stringify(events),before)
})
test('a complete sync has one CI owner even when its running receipt alone has two candidates',()=>{
 const attempt=job=>({project_id:443,pipeline_id:job,job_id:job})
 const events=[ci(1,'publication','succeeded',5,{attempt:attempt(100)}),ci(2,'deployment','succeeded',40,{attempt:attempt(100),runtime:{application_uid:'uid',verified_at:time(40)}}),ci(3,'publication','succeeded',10,{attempt:attempt(200)}),ci(4,'deployment','succeeded',25,{attempt:attempt(200),runtime:{application_uid:'uid',verified_at:time(25)}}),argo(5,'sync_running',20,{operation_started_at:time(20)}),argo(6,'sync_succeeded',30,{operation_started_at:time(20)})]
 const result=buildHistory(events)
 assert.equal(result.operations.length,2)
 const owner=result.operations.find(op=>op.events.some(e=>e.id===5))
 assert.ok(owner.events.some(e=>e.id===6))
 assert.equal(owner.events.find(e=>e.kind==='deployment').payload.attempt.job_id,100)
 assert.deepEqual(buildHistory([...events].reverse()),result)
})
test('failed sync keeps its entire lifecycle separate from a CI attempt',()=>{
 const events=[ci(1,'publication','succeeded',5),ci(2,'deployment','succeeded',40,{runtime:{application_uid:'uid',verified_at:time(40)}}),argo(3,'sync_running',20),argo(4,'sync_failed',30)]
 const result=buildHistory(events)
 assert.equal(result.operations.length,2)
 assert.deepEqual(result.operations.find(op=>op.kind==='argo').events.map(e=>e.id),[3,4])
 assert.deepEqual(buildHistory([...events].reverse()),result)
})
test('later manual sync, another incarnation, and another publication are not attached to an old delivery',()=>{
 const delivery=ci(1,'deployment','succeeded',20,{runtime:{application_uid:'uid',verified_at:time(20)}})
 for(const notification of [argo(2,'sync_succeeded',40),argo(2,'sync_succeeded',15,{application_uid:'new-uid'}),argo(2,'sync_succeeded',15,{revisions:['x'.repeat(40)]})])assert.equal(buildHistory([delivery,notification]).operations.length,2)
})
test('routine health and discovery stay in technical details while incidents and recovery remain visible',()=>{
 const result=buildHistory([argo(1,'created',1),argo(2,'health_changed',2),argo(3,'health_changed',10,{health:'Degraded'}),argo(4,'health_changed',20)])
 assert.equal(result.technical.length,2)
 assert.equal(result.operations.length,2)
 assert.equal(result.operations[0].title,'Приложение восстановилось')
 assert.equal(result.operations[1].tone,'danger')
})
test('native sync requires a confirmed application UID and its complete operation window inside the CI attempt',()=>{
 const start=ci(1,'publication','started',10),end=ci(2,'deployment','succeeded',30,{runtime:{application_uid:'uid',verified_at:time(30)}})
 const notifications=[argo(3,'sync_running',5,{operation_started_at:time(5)}),argo(4,'sync_succeeded',20,{operation_started_at:time(5)})]
 const separate=buildHistory([start,end,...notifications])
 assert.equal(separate.operations.length,2)
 assert.equal(separate.operations.find(row=>row.kind==='argo').events.length,2)
 for(const runtime of [undefined,{}]){
  const unconfirmed=ci(2,'deployment','failed',30,{runtime})
  assert.equal(buildHistory([start,unconfirmed,argo(4,'sync_succeeded',20)]).operations.length,2)
 }
 assert.equal(buildHistory([start,end,argo(4,'sync_succeeded',20,{operation_started_at:undefined})]).operations.length,2)
})
test('recovery remains visible through Progressing and is isolated by application identity',()=>{
 const result=buildHistory([argo(1,'health_changed',1,{health:'Degraded'}),argo(2,'health_changed',2,{health:'Progressing'}),argo(3,'health_changed',3,{application_uid:'another'}),argo(4,'health_changed',4),argo(5,'health_changed',5)])
 assert.equal(result.operations.length,2)
 assert.equal(result.operations[0].title,'Приложение восстановилось')
 assert.deepEqual(result.technical.map(item=>item.id),[5,3,2])
})
test('late health receipts preserve source chronology and recovery context on a single page',()=>{
 const healthy={...argo(1,'health_changed',20),previous_health:'Degraded'}
 const progressing={...argo(3,'health_changed',15,{health:'Progressing'}),previous_health:'Degraded'}
 const degraded={...argo(2,'health_changed',10,{health:'Degraded'}),previous_health:null}
 const before=JSON.stringify([healthy,progressing,degraded])
 for(const items of [[healthy,progressing,degraded],[degraded,progressing,healthy]]){
  const result=buildHistory(items)
  assert.deepEqual(result.operations.map(o=>o.title),['Приложение восстановилось','Argo: состояние Degraded'])
  assert.deepEqual(result.operations.map(o=>o.events[0].payload.health),['Healthy','Degraded'])
  assert.deepEqual(result.technical.map(e=>e.payload.health),['Progressing'])
 }
 assert.equal(JSON.stringify([healthy,progressing,degraded]),before)
})
test('API source-time context keeps recovery visible without the incident receipt on this page',()=>{
 const healthy={...argo(1,'health_changed',20),previous_health:'Degraded'}
 const result=buildHistory([healthy])
 assert.equal(result.operations[0].title,'Приложение восстановилось')
 assert.equal(result.operations[0].tone,'ok')
 assert.equal(result.technical.length,0)
 const later={...argo(4,'health_changed',30),previous_health:'Healthy'}
 const combined=buildHistory([later,healthy])
 assert.deepEqual(combined.operations.map(o=>o.events[0].id),[healthy.id])
 assert.deepEqual(combined.technical.map(e=>e.id),[later.id])
})
test('failure keeps a successful publication visible in details; retries use separate job identities',()=>{
 const events=[ci(1,'publication','succeeded',10),ci(2,'deployment','failed',20,{failure_code:'verification_failed'}),ci(3,'deployment','succeeded',30,{attempt:{project_id:443,pipeline_id:30,job_id:301}})]
 const result=buildHistory(events)
 assert.equal(result.operations.length,2)
 assert.equal(result.operations.find(r=>r.status==='Ошибка').events[0].payload.status,'succeeded')
})
test('feature deletion has its own lifecycle labels and native rows preserve application context',()=>{
 for(const [status,label]of [['started','Удаление feature началось'],['failed','Ошибка удаления feature'],['canceled','Удаление feature отменено'],['succeeded','Feature-окружение удалено']])assert.equal(eventLabel(ci(1,'deployment',status,10,{action:'delete'})),label)
 assert.equal(buildHistory([argo(1,'health_changed',10,{health:'Degraded',application:'feature-one'})]).operations[0].instance,'feature-one')
})
test('service history scopes deployment and Argo events to the selected environment and feature instance',()=>{
 const events=[ci(1,'deployment','succeeded',10),ci(2,'deployment','succeeded',11,{target:{environment:'prod',instance:'sample'}}),argo(3,'sync_succeeded',12),argo(4,'health_changed',13,{environment:'feature',application:'feature-other'}),ci(5,'build','succeeded',9,{source:{ref:'feature/other',revision:'a'.repeat(40)}})]
 assert.deepEqual(scopeHistory(events,'test','sample','dev').map(e=>e.id),[1,3])
 assert.deepEqual(scopeHistory(events).map(e=>e.id),[1,2,3,4,5])
})

test('stage durations use source timestamps from one attempt, even when receipts are delayed',()=>{
 const events=[ci(1,'publication','started',1),ci(2,'publication','succeeded',10),ci(3,'deployment','started',11),ci(4,'deployment','succeeded',30,{runtime:{application_uid:'uid',verified_at:time(30)}}),argo(5,'sync_running',12),argo(6,'sync_succeeded',20)]
 events.forEach((event,index)=>{event.received_at+=7200+index*300})
 const operation=buildHistory(events.reverse()).operations[0]
 assert.equal(operation.durationSeconds,29)
 assert.equal(operation.startedAt,Date.parse(time(1)))
 assert.equal(operation.finishedAt,Date.parse(time(30)))
 assert.deepEqual(operation.timings.map(timing=>[timing.kind,timing.durationSeconds]),[['publication',9],['deployment',19],['argocd',8]])
 assert.equal(eventTime(events.find(event=>event.id===4)),Date.parse(time(30)))
})

test('missing stage boundaries and malformed chronology do not invent durations',()=>{
 const terminal=ci(1,'deployment','succeeded',30)
 assert.equal(buildHistory([terminal]).operations[0].durationSeconds,undefined)
 assert.equal(historyTimings([ci(2,'publication','started',1),terminal]).every(timing=>timing.durationSeconds===undefined),true)
 assert.equal(buildHistory([ci(2,'publication','started',1),terminal]).operations[0].durationSeconds,undefined)
 assert.equal(historyTimings([ci(2,'deployment','started',40),terminal])[0].durationSeconds,undefined)
 const missing={...terminal,payload:{...terminal.payload,occurred_at:undefined}}
 assert.equal(historyTimings([ci(2,'deployment','started',1),missing])[0].durationSeconds,undefined)
 assert.equal(hasEventTime(missing),false)
 assert.equal(eventTime(missing),missing.received_at*1000)
 assert.equal(historyTimings([ci(2,'deployment','started',30),terminal])[0].durationSeconds,0)
})

test('stage timing never pairs different jobs, pipelines, branches, revisions, or actions',()=>{
 const start=ci(1,'deployment','started',1)
 for(const change of [{attempt:{project_id:443,pipeline_id:30,job_id:301}},
  {attempt:{project_id:443,pipeline_id:31,job_id:300}},
  {source:{ref:'feature/another',revision:'a'.repeat(40)}},
  {source:{ref:'dev',revision:'f'.repeat(40)}},{action:'delete'}]){
  const events=[start,ci(2,'deployment','succeeded',20,change)]
  assert.equal(buildHistory(events).operations.length,2)
  assert.equal(historyTimings(events).every(timing=>timing.durationSeconds===undefined),true)
 }
})

test('a native Argo terminal event can confirm its own duration but health changes cannot',()=>{
 const complete=argo(1,'sync_succeeded',20)
 assert.equal(buildHistory([complete]).operations[0].durationSeconds,8)
 const missingEnd=argo(2,'sync_succeeded',20,{operation_finished_at:undefined})
 assert.equal(historyTimings([missingEnd])[0].durationSeconds,undefined)
 assert.equal(eventTime(missingEnd),missingEnd.received_at*1000)
 assert.equal(hasEventTime(missingEnd),false)
 assert.deepEqual(historyTimings([argo(3,'health_changed',20)]),[])
 assert.equal(historyTimings([argo(4,'sync_running',20)])[0].durationSeconds,undefined)
 const delivery=ci(5,'deployment','succeeded',30,{runtime:{application_uid:'uid',verified_at:time(30)}})
 assert.equal(buildHistory([delivery,argo(6,'sync_succeeded',20,{source_ref:'another-branch'})]).operations.length,2)
})

test('new successful events preserve historical failures and do not mutate event payloads',()=>{
 const old=[ci(1,'deployment','failed',20,{failure_code:'verification_failed'}),argo(2,'health_changed',21,{health:'Degraded'})]
 const frozen=JSON.stringify(old)
 const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze)}return value}
 freeze(old)
 const before=buildHistory(old)
 const after=buildHistory([...old,ci(3,'deployment','succeeded',30,{attempt:{project_id:443,pipeline_id:31,job_id:301}}),argo(4,'health_changed',31)])
 for(const operation of before.operations){
  const retained=after.operations.find(item=>item.id===operation.id)
  assert.equal(retained.status,operation.status)
  assert.equal(retained.tone,operation.tone)
  assert.deepEqual(retained.events,operation.events)
 }
 assert.equal(after.operations.some(item=>item.status==='Успешно'),true)
 assert.equal(after.operations.some(item=>item.title==='Приложение восстановилось'),true)
 assert.equal(JSON.stringify(old),frozen)
})

test('durations keep compact standard units and retain subsecond executions',()=>{
 assert.equal(formatDuration(90061),'1d 1h 1m 1s')
 assert.equal(formatDuration(61),'1m 1s')
 assert.equal(formatDuration(.45),'450ms')
 assert.equal(formatDuration(0),'0s')
})
