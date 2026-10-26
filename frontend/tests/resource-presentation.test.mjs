import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceCard,resourceFields,displayStatus} from '../src/resource-presentation.ts'

const resource=(role,kind,fields=[],extra={})=>({id:'resource',role,kind,system:'kubernetes',title:'resource-name',identity:'technical-identity',fields,description:'Evidence',linkLabel:'Open',...extra})
test('useful runtime fields stay visible while identity and versions remain available in disclosure',()=>{
 const pod=resource('pod','Pod',[['UID','uid'],['Resource version','123'],['Namespace','app'],['Runtime observed at','2026-10-16T12:00:00Z'],['app imageID','containerd://sha256:abc'],['app restarts','2']])
 const before=structuredClone(pod),view=resourceFields(pod)
 assert.ok(view.primary.some(([key])=>key==='app imageID'))
 assert.ok(!view.primary.some(([key])=>['UID','Resource version'].includes(key)))
 assert.ok(view.additional['Происхождение'].some(([key])=>key==='UID'))
 assert.deepEqual(pod,before)
})
test('map captions identify branch, desired digest, common values and network endpoints without repeating namespace',()=>{
 assert.equal(resourceCard(resource('repo','Source code',[['Branch','feature/topic']])).caption,'feature/topic')
 assert.equal(resourceCard(resource('image','Container image',[['Digest','sha256:'+'a'.repeat(64)]])).caption,'digest '+ 'a'.repeat(12))
 assert.equal(resourceCard(resource('sourceValues','Source values',[['Common path','deploy/values.yaml']])).caption,'+ deploy/values.yaml')
 const ingress=resource('resource','Ingress',[['Namespace','app']],{endpoints:[{url:'https://example.test/feature/topic/',label:'example.test/feature/topic/'}]})
 assert.deepEqual(resourceCard(ingress,[],'app'),{title:'example.test',caption:'/feature/topic/',status:undefined})
 assert.match(resourceCard(ingress,[],'another').caption,/ns app/)
})
test('Argo inventory labels cannot imply native runtime or ESO synchronization',()=>{
 const eso=resource('eso','ExternalSecret',[['Evidence','Argo inventory']],{status:{label:'Synced',tone:'muted'}})
 assert.equal(displayStatus(eso).label,'Argo: Synced')
 const job=resource('workload','Job',[['Evidence','Argo inventory'],['Runtime observed at','now']],{status:{label:'Failed',tone:'danger'}})
 assert.equal(displayStatus(job).label,'Argo: Failed')
 assert.equal(displayStatus({...eso,status:{label:'Last snapshot',tone:'muted'}}).label,'Last snapshot')
})
test('consumer counts require observed selector edges, and long selectors stay secondary',()=>{
 const service=resource('resource','Service',[['Selector','long='+ 'x'.repeat(100)]])
 assert.equal(resourceCard(service).caption,undefined)
 assert.equal(resourceCard(service,[{from:'resource',to:'pod',label:'selects'}]).caption,'1 selected Pod')
 assert.equal(resourceFields(service).primary.length,0)
 assert.ok(resourceFields(service).additional['Размещение'].some(([key])=>key==='Selector'))
})
test('overview disclosure keeps full immutable versions but omits already visible branch and Argo status',()=>{
 const repo=resource('repo','Source code',[['Branch','dev'],['Build revision','a'.repeat(40)],['Project ID','42']])
 const groups=resourceFields(repo,'overview').additional
 assert.ok(groups['Версии'].some(([key])=>key==='Build revision'))
 assert.ok(groups['Происхождение'].some(([key])=>key==='Project ID'))
 assert.ok(!Object.values(groups).flat().some(([key])=>key==='Branch'))
 const argo=resource('argo','Argo Application',[['Values branch','main'],['Sync','Synced'],['Health','Healthy'],['Application UID','uid']],{status:{label:'Synced · Healthy',tone:'ok'}})
 assert.deepEqual(resourceFields(argo,'overview').additional['Происхождение'],[['Application UID','uid']])
})
test('archived and unassigned runtime numbers and last Argo status remain available',()=>{
 const workload=resource('workload','Deployment',[['Ready replicas','1'],['Target replicas','2'],['Pod restarts','3']],{componentIds:['component:api'],status:{label:'1 / 2 Ready',tone:'warn'}})
 assert.equal(resourceFields(workload,'overview').additional.Runtime.length,0)
 for(const other of [{...workload,componentIds:undefined},{...workload,status:{label:'Last snapshot',tone:'muted'}},{...workload,kind:'Job'}])assert.equal(resourceFields(other,'overview').additional.Runtime.length,3)
 const argo=resource('argo','Argo Application',[['Sync','Synced'],['Health','Healthy']],{status:{label:'Last snapshot',tone:'muted'}})
 assert.deepEqual(resourceFields(argo).additional['Происхождение'],[['Sync','Synced'],['Health','Healthy']])
})
