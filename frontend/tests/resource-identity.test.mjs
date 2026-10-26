import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {resourceFields} from '../src/resource-presentation.ts'

const key=(kind,name,namespace='sample')=>`k8s:${namespace}:${kind}:${name}`
const resource=(group,kind,name,namespace='sample',health='Healthy')=>({group,kind,name,namespace,status:'Synced',health})
const node=(uid,group,kind,name,health='Healthy',namespace='sample',parent_refs=[])=>({uid,group,kind,name,namespace,health,parent_refs})
function graph(resources,runtime) {
  return resourceGraph(
    {key:'sample',project:'team/sample',project_id:100,test_ref:'dev',team:null,registry_revision:'a'.repeat(40),instances:[]},
    {name:'sample',environment:'test',source_ref:'dev',lifecycle:{},observations:{argo:{name:'sample',namespace:'sample',uid:'app',present:true,
      observed_at:'2026-10-16T00:00:00Z',sync:'Synced',health:'Healthy',values_ref:'main',values_path:'kubernetes/test/sample/values.yaml',
      values_revision:'a'.repeat(40),resources,git:{source_revision:'b'.repeat(40),source_ref:'dev',images:[],workloads:[]},
      ...(runtime?{runtime:{application_uid:'app',observed_at:'2026-10-16T00:00:00Z',truncated:false,...runtime}}:{})}}},
    {gitlab:'https://git.example',deployments:'https://git.example/team/deployments.git',argo:{argo:'https://argo.example'}},
  )
}

test('same kind/name in two API groups keeps separate identities, statuses and namespace boundaries',()=>{
  const {data}=graph([
    resource('alpha.example.test','Widget','shared'),
    resource('beta.example.test','Widget','shared','sample','Degraded'),
    resource('beta.example.test','Widget','shared','foreign','Progressing'),
  ],{tree:[node('alpha','alpha.example.test','Widget','shared'),node('beta','beta.example.test','Widget','shared','Degraded')],objects:[]})
  const base=key('Widget','shared'),alpha=data[base+'@alpha.example.test'],beta=data[base+'@beta.example.test']
  assert.equal(data[base],undefined,'an ambiguous old link must not select an arbitrary API group')
  assert.ok(alpha&&beta)
  assert.equal(alpha.apiGroup,'alpha.example.test')
  assert.equal(beta.apiGroup,'beta.example.test')
  assert.equal(alpha.identity,'alpha')
  assert.equal(beta.identity,'beta')
  assert.equal(alpha.status.tone,'ok')
  assert.equal(beta.status.tone,'danger')
  assert.equal(data[key('Widget','shared','foreign')].status.tone,'warn')
  assert.equal(Object.values(data).filter(item=>item.kind==='Widget').length,3)
})

test('an unambiguous custom resource keeps its old deep link and full API group identity',()=>{
  const {data}=graph([resource('alpha.example.test','Widget','single')])
  const item=data[key('Widget','single')]
  assert.ok(item)
  assert.equal(item.identity,'alpha.example.test/sample/Widget/single')
  assert.ok(item.fields.some(([label,value])=>label==='API group'&&value==='alpha.example.test'))
})

test('native spec references resolve the canonical group while owner traversal follows exact UIDs',()=>{
  const resources=[resource('','Secret','shared'),resource('custom.example.test','Secret','shared','sample','Degraded'),
    resource('alpha.example.test','Widget','same'),resource('beta.example.test','Widget','same','sample','Degraded')]
  const {data,relationships}=graph(resources,{tree:[
    node('core-secret','','Secret','shared'),node('custom-secret','custom.example.test','Secret','shared','Degraded'),
    node('alpha','alpha.example.test','Widget','same'),node('beta','beta.example.test','Widget','same','Degraded'),
    node('pod','','Pod','api','Healthy','sample',[{uid:'beta',kind:'Widget',name:'same',group:'beta.example.test'}]),
  ],objects:[{uid:'pod',group:'',kind:'Pod',name:'api',namespace:'sample',owner_refs:[{uid:'beta',kind:'Widget',name:'same',group:'beta.example.test'}],
    images:[],containers:[],references:[{kind:'Secret',name:'shared',relation:'envFrom'}]}]})
  const pod=key('Pod','api'),core=key('Secret','shared')+'@~core',custom=key('Secret','shared')+'@custom.example.test'
  assert.equal(data[core].identity,'core-secret')
  assert.equal(data[custom].identity,'custom-secret')
  assert.ok(relationships.some(edge=>edge.from===core&&edge.to===pod&&edge.label==='envFrom'))
  assert.ok(!relationships.some(edge=>edge.from===custom&&edge.to===pod&&edge.label==='envFrom'))
  const owners=relationships.filter(edge=>edge.to===pod&&edge.label==='owns')
  assert.deepEqual(owners.map(edge=>edge.from),[key('Widget','same')+'@beta.example.test'])
})

test('Ingress default backend links the exact local Service without inventing an endpoint URL',()=>{
  const {data,relationships}=graph([
    resource('networking.k8s.io','Ingress','catchall'),resource('','Service','api'),resource('','Service','api','foreign'),
  ],{tree:[],objects:[
    {uid:'ingress',group:'networking.k8s.io',kind:'Ingress',name:'catchall',namespace:'sample',owner_refs:[],routes:[],default_backend_service:'api'},
    {uid:'service',group:'',kind:'Service',name:'api',namespace:'sample',owner_refs:[],selector:{},service_type:'ClusterIP'},
  ]})
  const ingress=data[key('Ingress','catchall')]
  assert.deepEqual(ingress.endpoints,[])
  assert.ok(ingress.fields.some(([label,value])=>label==='Default backend'&&value==='api'))
  const routes=relationships.filter(edge=>edge.from===ingress.id&&edge.label==='default backend')
  assert.equal(routes.length,1)
  assert.equal(routes[0].to,key('Service','api'))
  assert.ok(!relationships.some(edge=>edge.from===ingress.id&&edge.to===key('Service','api','foreign')))
})

test('controller generations are additional metadata and cannot override the Argo status',()=>{
  const {data}=graph([resource('apps','Deployment','api','sample','Progressing')],{tree:[],objects:[
    {uid:'deployment',group:'apps',kind:'Deployment',name:'api',namespace:'sample',owner_refs:[],generation:5,desired_replicas:3,
      status:{readyReplicas:3,observedGeneration:2}},
  ]})
  const deployment=data[key('Deployment','api')],fields=resourceFields(deployment)
  assert.equal(deployment.status.tone,'warn')
  assert.ok(!fields.primary.some(([label])=>/generation/i.test(label)))
  assert.ok(fields.additional['Версии'].some(([label,value])=>label==='Generation'&&value==='5'))
  assert.ok(fields.additional['Версии'].some(([label,value])=>label==='Observed generation'&&value==='2'))
})
