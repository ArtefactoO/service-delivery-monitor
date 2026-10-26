import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {traceResource} from '../src/graph-selection.ts'
import {resourceFields} from '../src/resource-presentation.ts'

function graph(files){
 const workload={key:'api',kind:'Deployment',config_files:['inline.yaml',...(files||[])],references:[],external_secret:{enabled:false}}
 return resourceGraph({key:'sample',project:'team/sample',project_id:1,test_ref:'dev'},
  {name:'sample',environment:'test',source_ref:'dev',lifecycle:{},observations:{test:{name:'sample',namespace:'sample',uid:'app',present:true,sync:'Synced',health:'Healthy',observed_at:'2026-01-01T00:00:00Z',chart_repo:'https://git.example/team/service-chart.git',values_ref:'main',values_path:'kubernetes/test/sample/values.yaml',values_revision:'a'.repeat(40),resources:[{kind:'Deployment',name:'sample-api',namespace:'sample',status:'Synced'}],git:{source_revision:'b'.repeat(40),images:[],config_project:'team/config',config_dir:'missing-directory',config_revision:'c'.repeat(40),config_ref:'master',...(files===undefined?{}:{config_managed_files:files}),workloads:[workload]}}}},
  {gitlab:'https://git.example',deployments:'https://git.example/team/deployments',argo:{test:'https://argo.example'}})
}

for(const [files,label] of [[[],'Файлы не импортированы'],[undefined,'Импорт файлов не подтвержден']]){
 test(`config discovery ${files===undefined?'without legacy file metadata':'with an empty import'} preserves provenance without invented files or directory links`,()=>{
  const {data,relationships}=graph(files)
  assert.equal(data.config,undefined)
  assert.ok(!relationships.some(edge=>edge.label==='config files'||edge.from==='config'))
  const provenance=Object.values(resourceFields(data.values,'overview').additional).flat()
  assert.ok(provenance.some(([key,value])=>key==='Config discovery'&&value===label))
  assert.ok(provenance.some(([key,value])=>key==='Checked config directory'&&value==='missing-directory'))
  assert.equal(data.values.fieldLinks['Config repository'],'https://git.example/team/config')
  assert.equal(data.values.fieldLinks['Config revision'],'https://git.example/team/config/-/tree/'+'c'.repeat(40))
  for(const resource of Object.values(data))for(const url of [resource.url,...Object.values(resource.fieldLinks||{})].filter(Boolean))assert.ok(!url.includes('/missing-directory'))
  assert.ok(relationships.some(edge=>edge.from==='values'&&edge.to==='k8s:sample:ConfigMap:sample-api-config'))
  assert.ok(relationships.some(edge=>edge.from==='k8s:sample:ConfigMap:sample-api-config'&&edge.to==='k8s:sample:Deployment:sample-api'))
 })
}

test('confirmed imported files retain config links and participate in the highlighted dependency path',()=>{
 const {data,relationships}=graph(['app.yaml'])
 assert.ok(data.config)
 assert.equal(data.config.url,'https://git.example/team/config/-/tree/'+'c'.repeat(40)+'/missing-directory')
 const edge=relationships.find(edge=>edge.from==='config'&&edge.to==='values')
 assert.equal(edge.label,'config files')
 assert.equal(edge.evidence,'publication-metadata')
 assert.ok(traceResource('k8s:sample:Deployment:sample-api',relationships,data).edges.has(edge))
 assert.equal(data['k8s:sample:ConfigMap:sample-api-config'].fieldLinks['File: app.yaml'],'https://git.example/team/config/-/blob/'+'c'.repeat(40)+'/missing-directory/app.yaml')
 assert.ok(!data.values.fields.some(([key])=>key==='Config discovery'))
})
