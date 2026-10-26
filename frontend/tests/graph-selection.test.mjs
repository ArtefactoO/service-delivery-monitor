import test from 'node:test'
import assert from 'node:assert/strict'
import { traceResource } from '../src/graph-selection.ts'

test('deployment selection reaches source code and secrets without entering sibling consumers', () => {
  const edges = [
    { from: 'source', to: 'image' }, { from: 'image', to: 'publication' },
    { from: 'publication', to: 'controller' }, { from: 'controller', to: 'target' },
    { from: 'vault', to: 'eso' }, { from: 'eso', to: 'secret' }, { from: 'secret', to: 'target' },
    { from: 'controller', to: 'sibling' }, { from: 'secret', to: 'sibling' },
    { from: 'unrelated', to: 'other' },
  ]
  const result = traceResource('target', edges)
  assert.ok(result.nodeIds.has('source'))
  assert.ok(result.nodeIds.has('vault'))
  assert.ok(result.edges.has(edges[0]))
  assert.ok(result.edges.has(edges[4]))
  assert.ok(!result.nodeIds.has('sibling'))
  assert.ok(!result.nodeIds.has('unrelated'))
  assert.ok(!result.edges.has(edges[7]))
})

test('source selection shows origins and immediate consumers without their unrelated inputs', () => {
  const edges = [{ from: 'source', to: 'image' }, { from: 'image', to: 'target' }, { from: 'secret', to: 'target' }]
  const result = traceResource('image', edges)
  assert.ok(result.nodeIds.has('source'))
  assert.ok(result.nodeIds.has('target'))
  assert.ok(!result.nodeIds.has('secret'))
})

test('cycles terminate and clearing selection clears highlighting', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]
  assert.equal(traceResource('a', edges).edges.size, 2)
  assert.equal(traceResource(null, edges).nodeIds.size, 0)
  assert.equal(traceResource(null, edges).edges.size, 0)
})

import { resourceGraph, safeUrl } from '../src/data.ts'
const registration = {key: 'new-service', project: 'team/new-service', project_id: 123, test_ref: 'dev', team: null, registry_revision: 'a'.repeat(40), instances: []}
const links = {gitlab: 'https://git.example', deployments: 'https://git.example/team/deployments.git', argo: {test: 'https://argo.example'}}
test('an unseen registration builds a source card without invented runtime', () => {
  const graph = resourceGraph(registration, undefined, links)
  assert.deepEqual(Object.keys(graph.data), ['repo'])
  assert.equal(graph.relationships.length, 0)
  assert.equal(graph.data.repo.url, 'https://git.example/team/new-service')
})
test('graph discovers arbitrary workload names and follows exact image references', () => {
  const image = {repository: 'registry.example/new-service', digest: 'sha256:' + 'b'.repeat(64)}
  const graph = resourceGraph(registration, {name: 'new-service', environment: 'test', observations: {test: {
    name: 'new-service', namespace: 'new-service', uid: 'example-uid', chart_repo: 'https://git.example/team/service-chart.git', chart_ref: 'v1.0.0',
    values_ref: 'main', values_path: 'kubernetes/test/new-service/values.yaml', values_revision: 'c'.repeat(40), observed_at: '2026-01-01',
    resources: [{kind: 'Deployment', name: 'new-service-custom-consumer', status: 'Synced'}],
    git: {source_revision: 'd'.repeat(40), build_revision: 'e'.repeat(40), images: [image], workloads: [{key: 'custom-consumer', kind: 'Deployment', image, config_files: [], references: [], external_secret: {enabled: false}}]},
  }}}, links)
  const trace = traceResource('k8s:new-service:Deployment:new-service-custom-consumer', graph.relationships,graph.data)
  assert.ok(trace.nodeIds.has('repo'))
  assert.ok(trace.nodeIds.has('chart'))
  assert.equal(graph.data['k8s:new-service:Deployment:new-service-custom-consumer'].status.label, 'Synced')
  assert.equal(graph.data['k8s:new-service:Deployment:new-service-custom-consumer'].status.tone, 'muted')
  assert.ok(!Object.values(graph.data).some(item => /Ready|Build passed/.test(item.status?.label || '')))
})
test('external navigation rejects active URLs and credentials', () => {
  assert.equal(safeUrl('javascript:alert(1)'), undefined)
  assert.equal(safeUrl('https://user:password@example.com'), undefined)
})

test('live Pods follow controller UIDs, report imageID, and preserve index digest distinction', async () => {
  const {enrichRuntime}=await import('../src/runtime-data.ts')
  const runtime={application_uid:'app',observed_at:'2026-01-01T00:00:00Z',truncated:false,tree:[
    {uid:'deployment',kind:'Deployment',name:'api',namespace:'sample',parent_refs:[]},
    {uid:'replicaset',kind:'ReplicaSet',name:'api-hash',namespace:'sample',parent_refs:[{uid:'deployment',kind:'Deployment',name:'api'}]},
    {uid:'pod',kind:'Pod',name:'api-hash-pod',namespace:'sample',parent_refs:[{uid:'replicaset',kind:'ReplicaSet',name:'api-hash'}]}],objects:[
    {uid:'deployment',kind:'Deployment',name:'api',namespace:'sample',owner_refs:[],desired_replicas:3,generation:2,status:{readyReplicas:2,observedGeneration:2}},
    {uid:'pod',kind:'Pod',name:'api-hash-pod',namespace:'sample',owner_refs:[{uid:'replicaset',kind:'ReplicaSet',name:'api-hash',controller:true}],phase:'Running',images:[{name:'app',image:'registry.example/api@sha256:index'}],containers:[{name:'app',ready:true,restarts:4,image:'registry.example/api@sha256:index',image_id:'containerd://sha256:platform-manifest',init:false}]}]}
  const data={repo:{id:'repo',role:'repo',fields:[]},image:{id:'image',role:'image',identity:'registry.example/api@sha256:index',fields:[]},'k8s:sample:Deployment:api':{id:'k8s:sample:Deployment:api',role:'workload',fields:[]}}
  const edges=[{from:'repo',to:'image',family:'source',label:'build source'},{from:'image',to:'k8s:sample:Deployment:api',family:'artifact',label:'desired image'}]
  enrichRuntime(data,edges,runtime,'https://argo.example/app')
  const pod=data['k8s:sample:Pod:api-hash-pod']
  assert.ok(pod.fields.some(([field,value])=>field==='app imageID'&&value==='containerd://sha256:platform-manifest'))
  assert.match(data['k8s:sample:Deployment:api'].subtitle,/2 \/ 3 Ready.*4 restarts/)
  assert.equal(data['k8s:sample:Deployment:api'].status.label,'Unknown')
  assert.equal(data['k8s:sample:Deployment:api'].status.tone,'muted')
  assert.equal(Object.values(data).filter(r=>r.role==='image').length,1)
  const trace=traceResource(pod.id,edges)
  assert.ok(trace.nodeIds.has('repo')&&trace.nodeIds.has('k8s:sample:ReplicaSet:api-hash'))
})

import { assignComponentMembership, buildComponents } from '../src/components.ts'
function multiComponentGraph({sharedImage = false} = {}) {
  const keys = ['processor', 'listener', 'scheduler', 'schema-update']
  const images = keys.map((key, index) => ({repository:`registry.example/${key}`,digest:'sha256:'+String(index+1).repeat(64)}))
  if (sharedImage) images[1] = images[0]
  const resources = keys.map((key,index)=>({kind:index===3?'Job':'Deployment',name:`release-${key}`,namespace:'sample',status:'Synced'}))
  const git = {source_revision:'a'.repeat(40),build_revision:'b'.repeat(40),images:[...new Map(images.map(image=>[image.repository,image])).values()],config_revision:'c'.repeat(40),config_project:'team/config',config_managed_files:keys.map(key=>`${key}.yaml`),workloads:keys.map((key,index)=>({
    key,kind:resources[index].kind,image:images[index],config_files:[`${key}.yaml`],references:[],external_secret:{enabled:true,env_from:true,store:{name:'test-vault'},remote_refs:[{key:`sample/${key}/runtime`}]},
  }))}
  const runtime = {application_uid:'app-uid',observed_at:'2026-01-01T00:00:00Z',truncated:false,tree:[
    {uid:'processor-controller',kind:'Deployment',name:'release-processor',namespace:'sample',parent_refs:[]},
    {uid:'processor-rs',kind:'ReplicaSet',name:'opaque-set',namespace:'sample',parent_refs:[{uid:'processor-controller',kind:'Deployment',name:'release-processor'}]},
    {uid:'processor-pod',kind:'Pod',name:'opaque-pod',namespace:'sample',parent_refs:[{uid:'processor-rs',kind:'ReplicaSet',name:'opaque-set'}]},
    {uid:'unrelated-pod',kind:'Pod',name:'release-processor-lookalike',namespace:'sample',parent_refs:[]},
  ],objects:[
    {uid:'processor-controller',kind:'Deployment',name:'release-processor',namespace:'sample',owner_refs:[],desired_replicas:2,generation:1,status:{readyReplicas:1,observedGeneration:1}},
    {uid:'processor-pod',kind:'Pod',name:'opaque-pod',namespace:'sample',owner_refs:[{uid:'processor-rs',kind:'ReplicaSet',name:'opaque-set',controller:true}],phase:'Running',images:[{name:'app',image:images[0].repository+'@'+images[0].digest}],containers:[]},
    {uid:'unrelated-pod',kind:'Pod',name:'release-processor-lookalike',namespace:'sample',owner_refs:[],phase:'Running',images:[],containers:[]},
  ]}
  return resourceGraph(registration,{name:'release',environment:'test',lifecycle:{},observations:{test:{
    name:'release',release_name:'release',namespace:'sample',uid:'app-uid',present:true,sync:'Synced',health:'Healthy',observed_at:'2026-01-01T00:00:00Z',
    chart_repo:'https://git.example/team/service-chart.git',chart_ref:'v1.0.0',values_ref:'main',values_path:'sample/values.yaml',values_revision:'d'.repeat(40),resources,git,runtime,
  }}},links)
}

test('a component trace includes shared publication context without crossing into sibling images/configs/secrets', () => {
  const graph=multiComponentGraph()
  const trace=traceResource('k8s:sample:Deployment:release-processor',graph.relationships,graph.data)
  for(const id of ['repo','values','sourceValues','argo','chart','config','image:registry.example/processor','vault:test-vault:sample/processor/runtime']) assert.ok(trace.nodeIds.has(id),id)
  for(const key of ['listener','scheduler','schema-update']) {
    assert.ok(!trace.nodeIds.has(`image:registry.example/${key}`),key+' image')
    assert.ok(!trace.nodeIds.has(`k8s:sample:ConfigMap:release-${key}-config`),key+' config')
    assert.ok(!trace.nodeIds.has(`vault:test-vault:sample/${key}/runtime`),key+' secret')
  }
  assert.ok(trace.nodeIds.has('k8s:sample:ReplicaSet:opaque-set'))
})

test('overview/map component membership follows exact workload keys and UID ancestry, never Pod name similarity', () => {
  const graph=multiComponentGraph(),grouped=buildComponents(graph.data)
  assert.equal(grouped.components.length,4)
  const processor=grouped.components.find(component=>component.key==='processor')
  assert.ok(processor.resources.some(resource=>resource.id==='k8s:sample:Pod:opaque-pod'))
  assert.ok(!processor.resources.some(resource=>resource.title==='release-processor-lookalike'))
  assert.ok(grouped.unassigned.some(resource=>resource.title==='release-processor-lookalike'))
  const trace=traceResource('k8s:sample:Pod:opaque-pod',graph.relationships,graph.data)
  assert.ok(trace.nodeIds.has('repo'))
  assert.ok(!trace.nodeIds.has('image:registry.example/listener'))
  assert.equal(grouped.components.find(component=>component.key==='schema-update').workloads[0].kind,'Job')
})

test('a shared image is represented once while component selection still excludes sibling workloads', () => {
  const graph=multiComponentGraph({sharedImage:true}),grouped=buildComponents(graph.data)
  const shared=grouped.shared.filter(resource=>resource.role==='image')
  assert.equal(shared.length,1)
  assert.deepEqual(shared[0].componentIds,['component:listener','component:processor'])
  const trace=traceResource('k8s:sample:Deployment:release-processor',graph.relationships,graph.data)
  assert.ok(trace.nodeIds.has(shared[0].id))
  assert.ok(!trace.nodeIds.has('k8s:sample:Deployment:release-listener'))
  assert.ok(!trace.nodeIds.has('image:registry.example/scheduler'))
})

test('unassigned image inputs do not become a claimed dependency through shared values', () => {
  const graph=multiComponentGraph()
  graph.data['unknown-image']={id:'unknown-image',role:'image',title:'unassigned',fields:[]}
  graph.relationships.push({from:'unknown-image',to:'values',label:'digest',family:'artifact'})
  assignComponentMembership(graph.data,graph.relationships,graph.data)
  const trace=traceResource('k8s:sample:Deployment:release-processor',graph.relationships,graph.data)
  assert.ok(!trace.nodeIds.has('unknown-image'))
  assert.ok(buildComponents(graph.data).unassigned.some(resource=>resource.id==='unknown-image'))
})
