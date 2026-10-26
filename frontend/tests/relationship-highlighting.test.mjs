import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {traceResource} from '../src/graph-selection.ts'
import {enrichNetwork} from '../src/network-data.ts'

const ns='scope', id=(kind,name)=>`k8s:${ns}:${kind}:${name}`
const image=(number)=>({repository:'registry.example/shared-app',digest:'sha256:'+String(number).repeat(64)})
const links={gitlab:'https://git.example',deployments:'https://git.example/platform/deployments.git',argo:{test:'https://argo.example'}}
function fixture({sharedImage=false,sharedSecret=false,sharedVault=false,inactive=false,truncated=false,extraPodRefs=[],initialImage=false,observedDrift=false,controllerKind='Deployment'}={}){
  const keys=['api','worker'],images=[image(1),image(sharedImage?1:2)]
  const inventory=[],tree=[],objects=[]
  const workloads=keys.map((key,index)=>{
    const name='app-'+key,uid=key+'-controller',pod=key+'-pod',set=key+'-set',secret=sharedSecret?'common-secret':name+'-runtime',parent=controllerKind==='Deployment'?{uid:set,kind:'ReplicaSet',name:set}:{uid,kind:controllerKind,name}
    for(const [kind,resourceName] of [[controllerKind,name],['ConfigMap',name+'-config'],['ExternalSecret',name+'-runtime'],['Service',key+'-http'],['Ingress',key+'-edge'],['ServiceAccount',key+'-account']])inventory.push({kind,name:resourceName,namespace:ns,status:'Synced'})
    tree.push({uid,kind:controllerKind,name,namespace:ns,parent_refs:[]},...(controllerKind==='Deployment'?[{uid:set,kind:'ReplicaSet',name:set,namespace:ns,parent_refs:[{uid,kind:controllerKind,name}]}]:[]),{uid:pod,kind:'Pod',name:pod,namespace:ns,parent_refs:[parent]})
    objects.push({uid,kind:controllerKind,name,namespace:ns,owner_refs:[],pod_labels:{component:key},service_account:key+'-account',desired_replicas:1,status:{readyReplicas:1}},
      {uid:pod,kind:'Pod',name:pod,namespace:ns,owner_refs:[{...parent,controller:true}],pod_labels:{component:key},images:[{name:'app',image:images[index].repository+'@'+(observedDrift&&index===0?image(typeof observedDrift==='number'?observedDrift:3).digest:images[index].digest)},...(initialImage?[{name:'setup',image:'registry.example/setup:v1',init:true}]:[])],containers:[{name:'app',ready:true,restarts:0,init:false}],references:[{kind:'Secret',name:secret,relation:'envFrom'},{kind:'ConfigMap',name:name+'-config',relation:'mount'},{kind:'ServiceAccount',name:key+'-account',relation:'service account'},...extraPodRefs]},
      {uid:key+'-service',kind:'Service',name:key+'-http',namespace:ns,owner_refs:[],selector:{component:key}},
      {uid:key+'-ingress',kind:'Ingress',name:key+'-edge',namespace:ns,owner_refs:[],routes:[{host:key+'.example.test',path:'/',path_type:'Prefix',tls:true,service_name:key+'-http'}]})
    return {key,kind:controllerKind,image:images[index],config_files:[key+'.yaml'],references:sharedSecret?[{kind:'Secret',name:secret,relation:'env'}]:[],external_secret:{enabled:true,env_from:true,store:{name:'vault'},remote_refs:[{key:'services/'+(sharedVault?'shared':key),property:'token'}]}}
  })
  const observation={name:'app',release_name:'app',namespace:ns,uid:'application',present:!inactive,sync:'Synced',health:'Healthy',observed_at:'2026-10-16T12:00:00Z',chart_repo:'https://git.example/platform/service-chart.git',chart_ref:'v1',values_ref:'main',values_path:'kubernetes/test/app/values.yaml',values_revision:'c'.repeat(40),resources:inventory,
    git:{source_revision:'a'.repeat(40),source_ref:'dev',build_revision:'b'.repeat(40),images,config_revision:'d'.repeat(40),config_project:'team/config',config_managed_files:keys.map(key=>key+'.yaml'),workloads},runtime:{application_uid:'application',observed_at:'2026-10-16T12:00:00Z',truncated,tree,objects}}
  return resourceGraph({key:'app',project:'team/app',project_id:1,test_ref:'dev',team:null,registry_revision:'f'.repeat(40),instances:[]},{id:'test',name:'app',environment:'test',source_ref:'dev',lifecycle:inactive?{stopped_at:'2026-10-16T13:00:00Z'}:{},observations:{test:observation}},links)
}
const trace=(graph,node)=>traceResource(node,graph.relationships,graph.data)
const imageId=(graph,index=1)=>Object.values(graph.data).find(resource=>resource.role==='image'&&resource.identity===image(index).repository+'@'+image(index).digest).id
const has=(result,...ids)=>{for(const node of ids)assert.ok(result.nodeIds.has(node),'missing '+node)}
const lacks=(result,...ids)=>{for(const node of ids)assert.ok(!result.nodeIds.has(node),'unexpected '+node)}
const context=['argo','chart','values','sourceValues']
const leaf=(key)=>[id('Deployment','app-'+key),id('ReplicaSet',key+'-set'),id('Pod',key+'-pod')]

test('ExternalSecret and Secret selection follows its secret chain and deployment context without unrelated build inputs',()=>{
  for(const kind of ['ExternalSecret','Secret']){
    const graph=fixture(),result=trace(graph,id(kind,'app-api-runtime'))
    has(result,'vault:vault:services/api',id('ExternalSecret','app-api-runtime'),id('Secret','app-api-runtime'),...leaf('api'),...context)
    lacks(result,'repo','config',imageId(graph,1),imageId(graph,2),'vault:vault:services/worker',...leaf('worker'))
    assert.ok(![...result.edges].some(edge=>edge.label==='digest'||edge.label==='config files'||edge.label==='build source'))
  }
})

test('Vault selection reaches ESO, Secret, workloads and Pods without gaining consumers other inputs',()=>{
  const graph=fixture(),result=trace(graph,'vault:vault:services/api')
  has(result,id('ExternalSecret','app-api-runtime'),id('Secret','app-api-runtime'),...leaf('api'))
  lacks(result,'repo','config',imageId(graph,1),'vault:vault:services/worker',...leaf('worker'))
})

test('Deployment and Pod selection reaches complete origins of their own component',()=>{
  for(const kind of ['Deployment','Pod']){
    const graph=fixture(),node=kind==='Deployment'?id(kind,'app-api'):id(kind,'api-pod'),result=trace(graph,node)
    has(result,'repo','config',imageId(graph,1),'vault:vault:services/api',id('ExternalSecret','app-api-runtime'),id('Secret','app-api-runtime'),id('ConfigMap','app-api-config'),id('Service','api-http'),id('Ingress','api-edge'),id('ServiceAccount','api-account'),...context)
    lacks(result,imageId(graph,2),'vault:vault:services/worker',id('ExternalSecret','app-worker-runtime'),id('ConfigMap','app-worker-config'),...leaf('worker'))
  }
})

test('Image selection follows its source and all exact consumers without their configuration dependencies',()=>{
  const graph=fixture(),result=trace(graph,imageId(graph,1))
  has(result,'repo',...leaf('api'))
  lacks(result,'config','vault:vault:services/api',id('ConfigMap','app-api-config'),id('Secret','app-api-runtime'),imageId(graph,2),...leaf('worker'))
  const shared=fixture({sharedImage:true}),selected=trace(shared,imageId(shared,1))
  has(selected,'repo',...leaf('api'),...leaf('worker'))
  lacks(selected,'config','vault:vault:services/api','vault:vault:services/worker')
})

test('same repository with distinct digests never joins different image consumers',()=>{
  const graph=fixture()
  assert.notEqual(imageId(graph,1),imageId(graph,2))
  for(const [index,own,other] of [[1,'api','worker'],[2,'worker','api']]){
    const result=trace(graph,imageId(graph,index))
    has(result,...leaf(own));lacks(result,...leaf(other))
  }
})

test('source code selection reaches its build consumers without lateral secrets or application config',()=>{
  const graph=fixture(),result=trace(graph,'repo')
  has(result,imageId(graph,1),imageId(graph,2),...leaf('api'),...leaf('worker'))
  lacks(result,'config','vault:vault:services/api','vault:vault:services/worker')
})

test('ConfigMap selection exposes config provenance and exact consumers but not images or Vault',()=>{
  const graph=fixture(),result=trace(graph,id('ConfigMap','app-api-config'))
  has(result,'config','values','sourceValues',...leaf('api'))
  lacks(result,'repo',imageId(graph,1),imageId(graph,2),'vault:vault:services/api',id('ConfigMap','app-worker-config'),...leaf('worker'))
})

test('application config selection follows only config data paths to component consumers',()=>{
  const graph=fixture(),result=trace(graph,'config')
  has(result,'values',id('ConfigMap','app-api-config'),id('ConfigMap','app-worker-config'),...leaf('api'),...leaf('worker'))
  lacks(result,'repo',imageId(graph,1),imageId(graph,2),'vault:vault:services/api','vault:vault:services/worker',id('ExternalSecret','app-api-runtime'))
})

test('explicit Application and chart selection follow controlled resources without claiming image or secret provenance',()=>{
  for(const selected of ['argo','chart']){
    const graph=fixture(),result=trace(graph,selected)
    has(result,'argo','chart','values','sourceValues',id('ConfigMap','app-api-config'),id('ExternalSecret','app-worker-runtime'),...leaf('api'),...leaf('worker'))
    lacks(result,'repo','config',imageId(graph,1),imageId(graph,2),'vault:vault:services/api','vault:vault:services/worker')
  }
})

test('source values and generated values retain distinct direct input contracts',()=>{
  const graph=fixture(),source=trace(graph,'sourceValues'),generated=trace(graph,'values')
  for(const result of [source,generated])has(result,'argo','values',id('ConfigMap','app-api-config'),...leaf('api'),...leaf('worker'))
  lacks(source,'repo','config',imageId(graph,1),imageId(graph,2),'vault:vault:services/api')
  has(generated,'sourceValues','config',imageId(graph,1),imageId(graph,2),'repo')
  lacks(generated,'vault:vault:services/api','vault:vault:services/worker')
})

test('projected Secret, ConfigMap and PVC references remain exact Pod inputs with no invented owners',()=>{
  const references=[{kind:'Secret',name:'injected-secret',relation:'projected mount'},{kind:'ConfigMap',name:'injected-config',relation:'projected mount'},{kind:'PersistentVolumeClaim',name:'storage',relation:'mount'}]
  const graph=fixture({extraPodRefs:references}),selected=trace(graph,id('Pod','api-pod'))
  for(const ref of references){
    const key=id(ref.kind,ref.name),edge=graph.relationships.find(edge=>edge.from===key&&edge.to===id('Pod','api-pod')&&edge.label===ref.relation)
    assert.ok(edge);has(selected,key)
    assert.equal(edge.family,ref.kind==='Secret'?'secret':'configuration')
    assert.ok(!graph.relationships.some(edge=>edge.to===key&&edge.label==='target'))
  }
})

test('observed init image links to its Pods without inheriting desired build provenance or inflating readiness',()=>{
  const graph=fixture({initialImage:true}),initial='observed-image:registry.example/setup:v1',result=trace(graph,initial)
  has(result,id('Pod','api-pod'),id('Pod','worker-pod'))
  lacks(result,'repo',imageId(graph,1),imageId(graph,2),id('Deployment','app-api'),id('Deployment','app-worker'))
  assert.match(graph.data[id('Pod','api-pod')].subtitle,/^1\/1 containers/)
})

test('controllers and ReplicaSets include observed drift and init images only from UID descendant Pods',()=>{
  for(const controllerKind of ['Deployment','StatefulSet','DaemonSet','Job']){
    const graph=fixture({controllerKind,observedDrift:true,initialImage:true}),actual='observed-image:'+image(3).repository+'@'+image(3).digest,initial='observed-image:registry.example/setup:v1'
    for(const selected of [id(controllerKind,'app-api'),...(controllerKind==='Deployment'?[id('ReplicaSet','api-set')]:[])]){
      const result=trace(graph,selected)
      has(result,id(controllerKind,'app-api'),id('Pod','api-pod'),imageId(graph,1),actual,initial)
      lacks(result,id(controllerKind,'app-worker'),id('Pod','worker-pod'),id('ReplicaSet','worker-set'),imageId(graph,2),'vault:vault:services/worker')
      assert.ok([...result.edges].some(edge=>edge.from===actual&&edge.to===id('Pod','api-pod')))
      assert.ok(![...result.edges].some(edge=>edge.from===initial&&edge.to===id('Pod','worker-pod')))
    }
    graph.data[id(controllerKind,'app-api')].role='resource'
    has(trace(graph,id(controllerKind,'app-api')),actual,initial)
    graph.data[id(controllerKind,'app-api')].role='workload'
    for(const selected of [imageId(graph,1),id('Secret','app-api-runtime')])lacks(trace(graph,selected),actual,initial)
  }
})

test('a rollout Pod using another component image does not pull that image other consumers into its controller trace',()=>{
  const graph=fixture({observedDrift:2}),result=trace(graph,id('Deployment','app-api'))
  has(result,imageId(graph,1),imageId(graph,2),...leaf('api'))
  lacks(result,...leaf('worker'),'vault:vault:services/worker',id('ConfigMap','app-worker-config'))
})

test('published and observed edges expose their own evidence without changing Secret or ESO status',()=>{
  const graph=fixture({initialImage:true}),secret=id('Secret','app-api-runtime'),eso=id('ExternalSecret','app-api-runtime')
  const edge=(from,to,label)=>{const result=graph.relationships.find(edge=>edge.from===from&&edge.to===to&&edge.label===label);assert.ok(result,'missing '+label);return result}
  const desired=edge(secret,id('Deployment','app-api'),'envFrom'),observed=edge(secret,id('Pod','api-pod'),'envFrom')
  assert.equal(desired.family,'secret');assert.equal(observed.family,'secret')
  assert.equal(desired.evidence,'published-values');assert.equal(observed.evidence,'kubernetes-spec')
  assert.equal(edge(eso,secret,'target').evidence,'published-values')
  assert.equal(edge('argo',eso,'manages').evidence,'argo-inventory')
  assert.equal(edge('chart','argo','chart source').evidence,'application-sources')
  assert.equal(edge('repo',imageId(graph,1),'build source').evidence,'publication-metadata')
  assert.equal(edge(id('Deployment','app-api'),id('ReplicaSet','api-set'),'owns').evidence,'argo-tree')
  assert.equal(edge('observed-image:registry.example/setup:v1',id('Pod','api-pod'),'init image').evidence,'kubernetes-spec')
  assert.equal(graph.data[secret].status.label,'Declared')
  assert.equal(graph.data[eso].status.label,'Synced')
  const allowed=new Set(['published-values','kubernetes-spec','argo-inventory','argo-tree','publication-metadata','application-sources'])
  for(const relation of graph.relationships)assert.ok(allowed.has(relation.evidence),'unattributed '+relation.label)
})

test('Ingress, Service and ServiceAccount selection follows only proven component consumers',()=>{
  for(const [kind,name] of [['Ingress','api-edge'],['Service','api-http'],['ServiceAccount','api-account']]){
    const graph=fixture(),result=trace(graph,id(kind,name))
    has(result,id('Deployment','app-api'),id('Pod','api-pod'))
    if(kind==='ServiceAccount')has(result,id('ReplicaSet','api-set'))
    else lacks(result,id('ReplicaSet','api-set'))
    lacks(result,'repo','config',imageId(graph,1),imageId(graph,2),'vault:vault:services/api',...leaf('worker'))
  }
})

test('a shared Secret exposes all its consumers while selecting one consumer excludes siblings',()=>{
  const graph=fixture({sharedSecret:true}),secret=id('Secret','common-secret')
  const result=trace(graph,secret)
  has(result,...leaf('api'),...leaf('worker'))
  lacks(result,'repo','config',imageId(graph,1),imageId(graph,2))
  const consumer=trace(graph,id('Deployment','app-api'))
  has(consumer,secret,...leaf('api'));lacks(consumer,...leaf('worker'),imageId(graph,2))
})

test('a shared Vault reference does not turn one ExternalSecret selection into its sibling branch',()=>{
  const graph=fixture({sharedVault:true}),selected=trace(graph,id('ExternalSecret','app-api-runtime'))
  has(selected,'vault:vault:services/shared',...leaf('api'))
  lacks(selected,id('ExternalSecret','app-worker-runtime'),id('Secret','app-worker-runtime'),...leaf('worker'))
  const common=trace(graph,'vault:vault:services/shared')
  has(common,id('ExternalSecret','app-api-runtime'),id('ExternalSecret','app-worker-runtime'),...leaf('api'),...leaf('worker'))
})

test('selectors never link a same-label workload in another namespace',()=>{
  const graph=fixture(),foreign='k8s:foreign:Deployment:app-api'
  graph.data[foreign]={id:foreign,role:'workload',kind:'Deployment',title:'app-api',componentIds:['component:foreign'],fields:[]}
  graph.observation.runtime.objects.push({uid:'foreign',kind:'Deployment',name:'app-api',namespace:'foreign',pod_labels:{component:'api'},owner_refs:[]})
  enrichNetwork(graph.data,graph.relationships,graph.observation.runtime)
  assert.ok(!graph.relationships.some(edge=>edge.from===id('Service','api-http')&&edge.to===foreign))
  lacks(trace(graph,id('Service','api-http')),foreign)
})

test('typed cycles terminate without adding unrelated resources',()=>{
  const resources={one:{role:'workload'},two:{role:'replicaSet'},three:{role:'pod'},outside:{role:'pod'}}
  const edges=[{from:'one',to:'two',label:'owns',family:'control'},{from:'two',to:'three',label:'owns',family:'control'},{from:'three',to:'one',label:'owns',family:'control'}]
  const selected=traceResource('two',edges,resources)
  has(selected,'one','two','three');lacks(selected,'outside');assert.equal(selected.edges.size,3)
})

test('all edges have real endpoints, unique identities, known families and English labels',()=>{
  const graph=fixture(),seen=new Set(),families=new Set(['source','artifact','configuration','secret','control'])
  for(const edge of graph.relationships){
    assert.ok(graph.data[edge.from]&&graph.data[edge.to])
    const key=edge.from+'|'+edge.label+'|'+edge.to
    assert.ok(!seen.has(key),'duplicate '+key);seen.add(key)
    assert.ok(families.has(edge.family));assert.ok(!/[А-Яа-яЁё]/.test(edge.label))
  }
})

test('selection is pure, clearing is neutral, and archived or partial snapshots preserve the same proven links',()=>{
  const graph=fixture(),serialized=JSON.stringify(graph)
  for(const resource of Object.keys(graph.data)){
    const result=trace(graph,resource)
    for(const edge of result.edges){assert.ok(result.nodeIds.has(edge.from));assert.ok(result.nodeIds.has(edge.to))}
  }
  assert.equal(JSON.stringify(graph),serialized)
  assert.equal(trace(graph,null).edges.size,0)
  assert.equal(trace(graph,null).nodeIds.size,0)
  for(const options of [{inactive:true},{truncated:true}]){
    const variant=fixture(options)
    assert.deepEqual([...trace(variant,id('Secret','app-api-runtime')).nodeIds].sort(),[...trace(graph,id('Secret','app-api-runtime')).nodeIds].sort())
    assert.deepEqual(variant.relationships,graph.relationships)
  }
})
