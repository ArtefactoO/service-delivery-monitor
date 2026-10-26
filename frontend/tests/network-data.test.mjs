import test from 'node:test'
import assert from 'node:assert/strict'
import {enrichNetwork,ingressUrl} from '../src/network-data.ts'
import {assignComponentMembership,buildComponents} from '../src/components.ts'
import {traceResource} from '../src/graph-selection.ts'
const resource=(kind,name,componentIds=[])=>({id:`k8s:ns:${kind}:${name}`,kind,title:name,role:kind==='Deployment'?'workload':'resource',componentIds,fields:[]})
test('ingress, Service and ServiceAccount membership follows spec, never name similarity',()=>{
 const controller=resource('Deployment','strange-controller',['component:api']),other=resource('Deployment','looks-like-service',['component:worker'])
 const service=resource('Service','looks-like-service'),ingress=resource('Ingress','entry'),unmatched=resource('Service','strange-controller')
 const data=Object.fromEntries([controller,other,service,ingress,unmatched].map(r=>[r.id,r])),edges=[]
 const runtime={objects:[
  {kind:'Deployment',name:controller.title,namespace:'ns',pod_labels:{app:'api'},service_account:'independent-account'},
  {kind:'Deployment',name:other.title,namespace:'ns',pod_labels:{app:'worker'}},
  {kind:'Service',name:service.title,namespace:'ns',selector:{app:'api'}},
  {kind:'Service',name:unmatched.title,namespace:'ns',selector:{}},
  {kind:'Ingress',name:ingress.title,namespace:'ns',routes:[{host:'api.example.test',path:'/api',path_type:'Prefix',tls:true,service_name:service.title}]}]}
 enrichNetwork(data,edges,runtime)
 assignComponentMembership(data,edges)
 for(const r of [service,ingress,data['k8s:ns:ServiceAccount:independent-account']])assert.deepEqual(r.componentIds,['component:api'])
 assert.deepEqual(unmatched.componentIds,[])
 assert.equal(ingress.endpoints[0].url,'https://api.example.test/api')
 const selected=traceResource(controller.id,edges)
 assert.ok(selected.nodeIds.has(ingress.id)&&selected.nodeIds.has(service.id))
 assert.ok(!selected.nodeIds.has(other.id)&&!selected.nodeIds.has(unmatched.id))
})
test('a selector targeting two components produces one shared Service',()=>{
 const a=resource('Deployment','one',['component:one']),b=resource('Deployment','two',['component:two']),service=resource('Service','shared')
 const data=Object.fromEntries([a,b,service].map(r=>[r.id,r])),edges=[]
 enrichNetwork(data,edges,{objects:[{kind:'Deployment',name:'one',namespace:'ns',pod_labels:{app:'shared'}},{kind:'Deployment',name:'two',namespace:'ns',pod_labels:{app:'shared'}},{kind:'Service',name:'shared',namespace:'ns',selector:{app:'shared'}}]})
 assignComponentMembership(data,edges)
 assert.equal(buildComponents(data).shared.filter(r=>r.kind==='Service').length,1)
 assert.deepEqual(service.componentIds,['component:one','component:two'])
})
test('ingress links respect TLS and concrete paths, reject wildcard hosts and unsupported regex',()=>{
 const route={host:'api.example.test',path:'/api',path_type:'Prefix',tls:false}
 assert.equal(ingressUrl(route),'http://api.example.test/api')
 assert.equal(ingressUrl({...route,tls:true}),'https://api.example.test/api')
 assert.equal(ingressUrl({...route,path:'/feature/foo(/|$)(.*)',path_type:'ImplementationSpecific'}),'http://api.example.test/feature/foo/')
 for(const host of ['*.example.test','user:password@example.test','javascript:alert(1)','api.example.test/escape'])assert.equal(ingressUrl({...route,host}),undefined)
 assert.equal(ingressUrl({...route,path:'/api/(foo|bar)',path_type:'ImplementationSpecific'}),undefined)
})
