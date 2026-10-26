import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'
import {resourceSearchText} from '../src/resource-presentation.ts'
import {relationshipEvidence,relationshipDetail} from '../src/relationship-evidence.ts'
const image={repository:'registry.example/app',digest:'sha256:'+'a'.repeat(64)}
function fixture(){
 const keys=['api','worker'],workloads=keys.map(key=>({key,kind:'Deployment',image,config_files:key==='api'?['app.yaml','inline.yaml']:[],config_mounts:[{subPath:'app.yaml',mountPath:'/etc/config/app.yaml'}],references:[],external_secret:{enabled:true,env_from:true,store:{name:'store'},remote_refs:[{key:'shared/path',property:key==='api'?'username':'password',mode:'property'},...(key==='worker'?[{key:'shared/path',mode:'extract'}]:[])]}}))
 return resourceGraph({key:'sample',project:'team/sample',project_id:1,test_ref:'dev',team:null,registry_revision:'a'},
 {name:'sample',environment:'test',lifecycle:{},source_ref:'dev',observations:{test:{name:'sample',namespace:'sample',uid:'app',present:true,sync:'Synced',health:'Healthy',observed_at:new Date().toISOString(),chart_repo:'https://git.example/team/service-chart.git',values_revision:'b'.repeat(40),values_path:'values.yaml',values_ref:'main',resources:keys.map(key=>({kind:'Deployment',name:'sample-'+key,namespace:'sample',status:'Synced'})),git:{source_revision:'c'.repeat(40),build_revision:'d'.repeat(40),build_pipeline:'99',images:[image],config_project:'team/config',config_dir:'sample',config_revision:'e'.repeat(40),config_managed_files:['app.yaml'],workloads}}}},
 {gitlab:'https://git.example',deployments:'https://git.example/team/deployments.git',argo:{test:'https://argo.example'}})
}
test('shared Vault metadata retains every property and distinguishes full extract',()=>{
 const graph=fixture(),vault=graph.data['vault:store:shared/path']
 assert.equal(Object.values(graph.data).filter(resource=>resource.role==='vault').length,1)
 assert.equal(vault.fields.find(([key])=>key==='Properties')[1],'All properties (extract)\npassword\nusername')
 assert.ok(graph.relationships.filter(edge=>edge.from===vault.id).every(edge=>edge.evidence==='published-values'))
 assert.ok(graph.relationships.some(edge=>edge.from===vault.id&&edge.to==='k8s:sample:ExternalSecret:sample-worker-runtime'&&edge.label==='extract'))
})
test('config file links require recorded external provenance and mounts remain explicit published facts',()=>{
 const {data}=fixture(),config=data['k8s:sample:ConfigMap:sample-api-config']
 assert.equal(config.fields.find(([key])=>key==='Published mounts')[1],'app.yaml → /etc/config/app.yaml')
 assert.equal(config.fieldLinks['File: app.yaml'],'https://git.example/team/config/-/blob/'+'e'.repeat(40)+'/sample/app.yaml')
 assert.equal(config.fieldLinks['File: inline.yaml'],undefined)
 assert.equal(data['image:registry.example/app'].fieldLinks['Build pipeline'],'https://git.example/team/sample/-/pipelines/99')
})
test('map search finds displayed Ingress hostname/path while evidence labels stay English',()=>{
 const ingress={id:'entry',role:'resource',kind:'Ingress',title:'technical-name',fields:[],endpoints:[{label:'app.example/feature/',url:'https://app.example/feature/'}]}
 assert.match(resourceSearchText(ingress),/app\.example\/feature/)
 assert.match(resourceSearchText(ingress),/technical-name/)
 assert.equal(relationshipEvidence({evidence:'published-values'}),'Published values')
 assert.equal(relationshipEvidence({evidence:'kubernetes-spec'}),'Kubernetes spec')
})
test('TLS and image pull references explain distinct consumers without claiming env injection',()=>{
 assert.match(relationshipDetail({evidence:'kubernetes-spec',label:'TLS secret'}),/Ingress spec\.tls\[\]\.secretName/)
 assert.match(relationshipDetail({evidence:'kubernetes-spec',label:'image pull secret'}),/Pod spec\.imagePullSecrets\[\]\.name/)
 assert.match(relationshipDetail({evidence:'kubernetes-spec',label:'image pull secret'}),/не env приложения/)
 assert.equal(relationshipDetail({evidence:'published-values',label:'envFrom'}),undefined)
})
test('a slower runtime check cannot overwrite a newer Argo inventory Health',()=>{
 const graph=fixture(),observation=graph.observation
 observation.inventory_observed_at='2026-10-19T12:00:00Z'
 observation.resources[0].health='Degraded'
 observation.runtime={application_uid:'app',observed_at:'2026-10-19T11:00:00Z',truncated:false,objects:[],tree:[
  {uid:'api',kind:'Deployment',group:'apps',name:'sample-api',namespace:'sample',parent_refs:[],resourceVersion:'10',health:'Healthy'},
 ]}
 const rebuilt=resourceGraph({key:'sample',project:'team/sample',project_id:1,test_ref:'dev'},
  {name:'sample',environment:'test',lifecycle:{},source_ref:'dev',observations:{test:observation}},
  {argo:{test:'https://argo.example'}})
 assert.match(rebuilt.data['k8s:sample:Deployment:sample-api'].status.label,/Degraded/)
})
