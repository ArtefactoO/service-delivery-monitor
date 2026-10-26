// Synthetic HTTP fixtures; no identity-provider or production login is impersonated.
const {chromium} = require(process.env.SDM_PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const root = process.env.SDM_BROWSER_URL || 'http://host.docker.internal:4318'
const output = process.env.SDM_BROWSER_ARTIFACTS || '/artifacts'
const now = new Date().toISOString(), image = {repository: 'registry.example/sample', digest: 'sha256:'+'b'.repeat(64)}
const base = {key:'sample', project:'team/sample', project_id:123, test_ref:'dev', team:null, registry_revision:'a'.repeat(40)}
const obs = {name:'sample', namespace:'sample', uid:'fixture-uid', present:true, sync:'Synced', health:'Healthy', observed_at:now, check_interval_seconds:600, chart_repo:'https://git.example/team/service-chart.git', chart_ref:'v1.2.3', values_ref:'main', values_path:'kubernetes/test/sample/values.yaml', values_revision:'c'.repeat(40), resources:[{kind:'Deployment',name:'sample-api',namespace:'sample',status:'Synced',health:'Healthy'},{kind:'ExternalSecret',name:'sample-api-runtime',namespace:'sample',status:'Synced',health:'Healthy'}], git:{source_revision:'d'.repeat(40),build_revision:'e'.repeat(40),source_ref:'dev',images:[image], config_revision:'f'.repeat(40),config_project:'config/test',config_dir:'sample',workloads:[{key:'api',kind:'Deployment',image,desired_replicas:2,config_files:['app.yaml'],references:[],external_secret:{enabled:true,env_from:true,store:{name:'vault-services-test'},remote_refs:[{key:'sample/test/runtime',property:'database_url'}]}}]}}
const instance = {id:'sample:test:sample',name:'sample',environment:'test',source_ref:'dev',lifecycle:{created_at:new Date(Date.now()-86400000).toISOString()},observations:{test:obs},lifetime_seconds:86400}
obs.runtime={application_uid:'fixture-uid',observed_at:now,truncated:false,tree:[
 {uid:'deployment',kind:'Deployment',name:'sample-api',namespace:'sample',health:'Progressing',parent_refs:[]},
 {uid:'rs',kind:'ReplicaSet',name:'sample-api-hash',namespace:'sample',parent_refs:[{uid:'deployment',kind:'Deployment',name:'sample-api'}]},
 {uid:'pod',kind:'Pod',name:'sample-api-hash-pod',namespace:'sample',health:'Healthy',parent_refs:[{uid:'rs',kind:'ReplicaSet',name:'sample-api-hash'}]}],objects:[
 {uid:'deployment',kind:'Deployment',name:'sample-api',namespace:'sample',owner_refs:[],desired_replicas:2,generation:1,status:{readyReplicas:1,observedGeneration:1}},
 {uid:'pod',kind:'Pod',name:'sample-api-hash-pod',namespace:'sample',owner_refs:[{uid:'rs',kind:'ReplicaSet',name:'sample-api-hash',controller:true}],phase:'Running',images:[{name:'app',image:image.repository+'@'+image.digest}],containers:[{name:'app',ready:true,restarts:2,image_id:'containerd://sha256:'+'e'.repeat(64),init:false}]}]}
const feature = {...instance,id:'sample:feature:feature-one',name:'feature-one',environment:'feature',source_ref:'feature/topic',lifecycle:{...instance.lifecycle,auto_stop_at:new Date(Date.now()+7200000).toISOString()},observations:{test:{...obs,name:'feature-one'}}}
const summary = {...instance,...obs,source:'test',images:[image],source_revision:'e'.repeat(40)}
summary.runtime={ready:1,desired:2,pods:1,restarts:2,observed_at:now,truncated:false}
delete summary.observations // Catalog uses flattened summaries, not detail instances.
const links = {gitlab:'https://git.example',argo:{test:'https://argo.example'},argo_check_intervals:{test:600},deployments:'https://git.example/team/deployments.git',vault_stores:{'vault-services-test':{url:'https://vault.example',mount:'services'}}}
// Four arbitrary components, one genuinely shared image/secret, and a completed Job.
for (const [key,kind,digest] of [['listener','Deployment','c'],['worker','Deployment','b'],['migrator','Job','d']]) {
 const resourceName=`sample-${key}${kind==='Job'?'-'+'d'.repeat(12):''}`
 const componentImage={repository: key==='worker'?image.repository:`registry.example/sample-${key}`,digest:'sha256:'+digest.repeat(64)}
 if(key!=='worker')obs.git.images.push(componentImage)
 obs.git.workloads.push({key,kind,image:componentImage,desired_replicas:1,config_files:[`${key}.yaml`],references:[{kind:'Secret',name:'sample-shared',relation:'envFrom'}],external_secret:{enabled:false}})
 obs.resources.push({kind,name:resourceName,namespace:'sample',status:'Synced',health:'Healthy'})
 obs.runtime.tree.push({uid:key,kind,name:resourceName,namespace:'sample',health:'Healthy',parent_refs:[]})
 obs.runtime.objects.push({uid:key,kind,name:resourceName,namespace:'sample',owner_refs:[],desired_replicas:kind==='Job'?undefined:1,generation:1,status:kind==='Job'?{succeeded:1,conditions:[{type:'Complete',status:'True'}]}:{readyReplicas:1,observedGeneration:1}})
 const parentUid=kind==='Job'?key:`${key}-rs`,parentKind=kind==='Job'?'Job':'ReplicaSet'
 if(kind!=='Job')obs.runtime.tree.push({uid:parentUid,kind:'ReplicaSet',name:`${resourceName}-hash`,namespace:'sample',parent_refs:[{uid:key,kind,name:resourceName}]})
 const podName=`${resourceName}-pod`
 obs.runtime.tree.push({uid:`${key}-pod`,kind:'Pod',name:podName,namespace:'sample',parent_refs:[{uid:parentUid,kind:parentKind,name:kind==='Job'?resourceName:`${resourceName}-hash`}]})
 obs.runtime.objects.push({uid:`${key}-pod`,kind:'Pod',name:podName,namespace:'sample',owner_refs:[{uid:parentUid,kind:parentKind,name:resourceName,controller:true}],phase:kind==='Job'?'Succeeded':'Running',images:[{name:'app',image:componentImage.repository+'@'+componentImage.digest}],containers:[{name:'app',ready:kind!=='Job',restarts:0,image_id:'containerd://sha256:'+digest.repeat(64),init:false}]})
}
const featureTwo={...feature,id:'sample:feature:feature-two',name:'feature-two',source_ref:'feature/another-topic-with-a-long-name',observations:{test:{...obs,name:'feature-two'}}}
obs.git.config_ref='master'
obs.git.config_managed_files=[...new Set(obs.git.workloads.flatMap(workload=>workload.config_files))]
const stoppedFeature={...feature,id:'sample:feature:old-feature',name:'old-feature',source_ref:'feature/stopped',lifecycle:{...feature.lifecycle,stopped_at:now}}
obs.runtime.objects[0].pod_labels={component:'api'}
obs.runtime.objects[0].service_account='sample-identity'
obs.resources.push(...[{kind:'Service',name:'routing-service'},{kind:'Ingress',name:'entry'},{kind:'ServiceAccount',name:'sample-identity'}].map(r=>({...r,namespace:'sample',status:'Synced'})))
obs.runtime.objects.push({kind:'Service',name:'routing-service',namespace:'sample',uid:'service',selector:{component:'api'},owner_refs:[]},
 {kind:'Ingress',name:'entry',namespace:'sample',uid:'ingress',owner_refs:[],routes:[{host:'sample.example.test',path:'/api',path_type:'Prefix',tls:true,service_name:'routing-service'}]})
const latestAttempts=[
 {key:'sample:build:dev',received_at:Date.now()/1000,payload:{kind:'build',status:'failed',source:{ref:'dev',revision:'a'.repeat(40)},attempt:{pipeline_id:30,job_id:300},failure_code:'build_failed'}},
 {key:'sample:test:sample:publication',received_at:Date.now()/1000,payload:{kind:'publication',status:'succeeded',source:{ref:'dev',revision:'a'.repeat(40)},target:{environment:'test',instance:'sample'},attempt:{pipeline_id:31,job_id:310}}}]
async function selectResource(page,id) {
 const [, ,kind,name]=id.split(':')
 const picker=page.getByRole('combobox',{name:'Выбрать ресурс',exact:true})
 await picker.fill(name)
 await page.getByRole('option',{name:`${name} ${kind==='Secret'?'Kubernetes Secret':kind}`,exact:true}).click()
}
async function assertMapLabels(page) {
 const conflicts=await page.evaluate(()=>{
  const overlap=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5
  const cards=[...document.querySelectorAll('.logical-node')].map(el=>({name:el.dataset.resource,box:el.getBoundingClientRect()}))
  const labels=[...document.querySelectorAll('.logical-edge-label')].map(el=>({name:el.textContent,id:el.dataset.edgeLabelId,box:el.getBoundingClientRect(),transform:el.style.transform}))
  return labels.flatMap((label,index)=>[
   ...cards.filter(card=>overlap(label.box,card.box)).map(card=>`${label.name} / ${card.name}`),
   ...labels.slice(0,index).filter(other=>overlap(label.box,other.box)&&!(label.name===other.name&&Math.abs(label.box.x-other.box.x)<.5&&Math.abs(label.box.y-other.box.y)<.5)).map(other=>({a:label.id,b:other.id,at:[label.box.x,label.box.y,label.box.width,label.box.height],bt:[other.box.x,other.box.y,other.box.width,other.box.height],transforms:[label.transform,other.transform]}))
  ])
 })
 assert.deepEqual(conflicts,[],'whole edge labels stay outside every card')
}
async function assertMiniMapPan(page) {
 const id=await page.locator('[data-resource*="k8s:sample:Pod:"]').evaluateAll(nodes=>nodes.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0].dataset.resource)
 await selectResource(page,id)
 await page.getByRole('button',{name:'К выбранному ресурсу',exact:true}).click()
 for(const targetZoom of [.95,1.8]) {
  if(targetZoom>1)for(let count=0;count<5;count++) {
   const button=page.getByRole('button',{name:'Увеличить карту',exact:true})
   if(await button.isDisabled())break
   await button.click();await page.waitForTimeout(170)
  }
  const area=await page.locator('.logical-flow-area').boundingBox()
  await page.mouse.move(area.x+8,area.y+area.height-8)
  await page.mouse.down()
  await page.mouse.move(area.x-16000,area.y-16000,{steps:5})
  await page.mouse.up()
  // On a short laptop viewport the rectangular graph corner can be below the
  // final Pod (other columns extend lower). Pan back to its free visible area.
  const atLimit=await page.locator(`[data-resource="${id}"]`).boundingBox()
  if(atLimit.y<area.y+8||atLimit.x<area.x+8){
   await page.mouse.move(area.x+8,area.y+area.height-8)
   await page.mouse.down()
   await page.mouse.move(area.x+8+Math.max(0,area.x+24-atLimit.x),area.y+area.height-8+Math.max(0,area.y+24-atLimit.y),{steps:4})
   await page.mouse.up()
  }
  const node=await page.locator(`[data-resource="${id}"]`).boundingBox(),mini=await page.locator('.react-flow__minimap').boundingBox()
  assert.ok(node.x>=area.x&&node.y>=area.y&&node.x+node.width<=area.x+area.width&&node.y+node.height<=area.y+area.height,'the final Pod can be fully revealed at the bounded pan limit')
  assert.ok(node.x+node.width<=mini.x||node.y+node.height<=mini.y,'the minimap does not cover the final Pod')
  const fixed=await page.locator('.react-flow__viewport').getAttribute('style')
  await page.getByRole('button',{name:'Закрыть детали ресурса',exact:true}).click()
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),fixed)
  await selectResource(page,id)
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),fixed)
 }
 await page.getByRole('button',{name:'Закрыть детали ресурса',exact:true}).click()
 await page.getByRole('button',{name:'Вся карта',exact:true}).click()
 const mini=await page.locator('.react-flow__minimap').boundingBox()
 for(const node of await page.locator('.logical-node').all()) {
  const box=await node.boundingBox()
  assert.ok(box.x+box.width<=mini.x||box.y+box.height<=mini.y,'fit reserves the minimap area')
 }
}
const historyTime=seconds=>new Date(Date.parse(now)+seconds*1000).toISOString()
const historyCI=(id,kind,status,seconds)=>({id,service:'sample',kind,received_at:Date.parse(now)/1000,applied:true,payload:{status,occurred_at:historyTime(seconds),source:{ref:'dev',revision:'a'.repeat(40)},attempt:{project_id:443,pipeline_id:31,job_id:310},target:{environment:'test',instance:'sample'},publication:{revision:'c'.repeat(40)},...(kind==='deployment'&&status==='succeeded'?{runtime:{application_uid:'fixture-uid',verified_at:now}}:{})}})
const historyArgo=(id,event,seconds)=>({id,service:'sample',kind:'argocd_notification',received_at:Date.parse(now)/1000,applied:false,payload:{event,source:'test',application:'sample',application_uid:'fixture-uid',source_ref:'dev',environment:'test',health:'Healthy',sync:'Synced',revisions:['c'.repeat(40)],operation_started_at:historyTime(-20),operation_finished_at:historyTime(seconds),health_changed_at:historyTime(seconds)}})
const historySample=[historyCI(1,'publication','started',-30),historyCI(2,'publication','succeeded',-25),historyCI(3,'deployment','started',-24),historyArgo(4,'sync_running',-20),historyArgo(5,'sync_succeeded',-5),historyArgo(6,'health_changed',-3),historyCI(7,'deployment','succeeded',0)]
const targetlessBuild={...historyCI(8,'build','succeeded',1),payload:{...historyCI(8,'build','succeeded',1).payload,target:undefined,source:{ref:'v1.2.3',revision:'a'.repeat(40)}}}
const archivedStop={...historyCI(100,'deployment','succeeded',-1000),payload:{...historyCI(100,'deployment','succeeded',-1000).payload,action:'delete',source:{ref:'feature/stopped'},target:{environment:'feature',instance:'old-feature'}}}
const archivedPage=[archivedStop,...Array.from({length:49},(_,index)=>{const item=historyArgo(101+index,'health_changed',-990+index);return {...item,payload:{...item.payload,application:'old-feature',environment:'feature',source_ref:'feature/stopped'}}})]
const archivedOlder={...historyCI(50,'build','succeeded',-2000),payload:{...historyCI(50,'build','succeeded',-2000).payload,target:undefined,source:{ref:'feature/stopped'},attempt:{project_id:123,pipeline_id:20,job_id:200}}}
;(async()=>{
 const browser = await chromium.launch({headless:true})
 try {
  for (const [width,height,theme] of [[1366,768,'dark'],[1366,768,'light'],[1512,900,'dark'],[1512,900,'light'],[1920,1000,'dark'],[1920,1000,'light']]) {
   if(process.env.SDM_BROWSER_CASE&&process.env.SDM_BROWSER_CASE!==`${width}-${theme}`)continue
   const context = await browser.newContext({viewport:{width,height},colorScheme:theme})
   const page = await context.newPage(), errors = []
   page.on('pageerror', error=>errors.push(error.message))
   let signedIn = false, catalogExtra = false, catalogDeployed = false, fail = false, manyFeatures = true, runtimeFailure=false, staleSnapshot=false, duplicateBranches=false, publishedEnvironments=['test','feature']
   await page.route('**/auth/session', route=>route.fulfill({json:{user:signedIn?{sub:'fixture',name:'Fixture Viewer',email:'viewer@example.test',role:'viewer'}:null,sso_enabled:true}}))
   await page.route('**/api/v1/**', async route=>{
    if (!signedIn) return route.fulfill({status:401,json:{detail:'invalid_credentials'}})
    if (fail) return route.fulfill({status:503,json:{error:'storage_unavailable'}})
    const path = new URL(route.request().url()).pathname
    let body
    if(path==='/api/v1/services') body={items:[{...base,instances:[summary,{...summary,environment:'feature',name:'feature-one'},...(manyFeatures?[{...summary,environment:'feature',name:'feature-two',source_ref:featureTwo.source_ref,health:'Degraded'}]:[])]},...(catalogExtra?[{...base,key:'automatically-added',project:'team/new',project_id:124,instances:catalogDeployed?[{...summary,name:'automatically-added'}]:[]}]:[]),{...base,key:'absent-service',instances:[{...summary,present:false}]},{...base,key:'stopped-service',instances:[{...summary,lifecycle:{stopped_at:now}}]}],environments:publishedEnvironments,links}
    else if(path==='/api/v1/services/sample') {await new Promise(resolve=>setTimeout(resolve,300));body={service:base,instances:[instance,feature,...(manyFeatures?[featureTwo]:[]),stoppedFeature],generated_at:now,latest_attempts:latestAttempts};if(runtimeFailure){body=structuredClone(body);const pod=body.instances[0].observations.test.runtime.objects.find(item=>item.uid==='pod');pod.phase='Failed';pod.containers[0].ready=false;body.instances[0].observations.test.runtime.tree.find(item=>item.uid==='pod').health='Degraded'}}
    else if(path==='/api/v1/sources') body={items:[{name:'test',kind:'argocd',interval_seconds:600,last_success_at:Date.now()/1000,last_attempt_at:Date.now()/1000,error_code:null,failures:0,window_count:30,requests_per_window:30,window_start:Date.now()/1000-60,window_seconds:300,next_request_at:Date.now()/1000+2,backoff_until:0,min_request_interval_seconds:2,timeout_seconds:10}]}
    else if(path.endsWith('/events')){const query=new URL(route.request().url()).searchParams;body={items:query.get('instance')==='sample:feature:old-feature'?(query.has('before')?[archivedOlder]:archivedPage):[...historySample,targetlessBuild]}}
    else body={items:[]}
    if(duplicateBranches&&path==='/api/v1/services/sample'){
     body=structuredClone(body)
     body.instances.find(item=>item.name==='feature-two').source_ref=feature.source_ref
    }
    if(staleSnapshot&&path==='/api/v1/services/sample'){
     body=structuredClone(body)
     const snapshot=body.instances[0].observations.test
     snapshot.observed_at=new Date(Date.now()-3600000).toISOString()
     snapshot.runtime.observed_at=snapshot.observed_at
    }
    return route.fulfill({json:body})
   })
   await page.goto(root+'/?page=service&service=sample&view=map&resource=repo')
   await page.getByRole('link',{name:'Войти через Authentik'}).waitFor()
   assert.equal(await page.locator('.service-catalog-card').count(),0)
   assert.match(await page.getByRole('link',{name:'Войти через Authentik'}).getAttribute('href'), /next=/)
   await page.screenshot({path:`${output}/login-${width}-${theme}.png`})
   signedIn=true
   await page.reload()
   await page.locator('[data-resource="repo"]').waitFor()
   await page.locator('[data-resource="repo"] .logical-node-meta').getByText('dev',{exact:true}).waitFor()
   await page.getByRole('button',{name:'Закрыть детали ресурса',exact:true}).click()
   const viewport=await page.locator('.react-flow__viewport').getAttribute('style')
   const zoom=Number(viewport.match(/scale\(([\d.]+)\)/)?.[1])
   assert.ok(zoom>=0.85,`readable initial zoom: ${zoom}`)
   await page.locator('.react-flow__minimap').waitFor()
   await assertMapLabels(page)
   await page.getByRole('button',{name:'Вся карта',exact:true}).focus()
   await page.keyboard.press('Tab')
   const focus=await page.evaluate(()=>{
    const element=document.activeElement,canvas=document.querySelector('.logical-flow-area').getBoundingClientRect(),box=element.getBoundingClientRect()
    return {isNode:element.matches('.logical-node'),visible:box.left>=canvas.left&&box.top>=canvas.top&&box.right<=canvas.right&&box.bottom<=canvas.bottom}
   })
   assert.ok(!focus.isNode||focus.visible,'sequential keyboard focus cannot enter an offscreen node')
   const captionPositions=await page.locator('.logical-edge-label').evaluateAll(nodes=>nodes.map(el=>[el.dataset.edgeLabelId,el.style.transform]))
   await selectResource(page,'k8s:sample:Deployment:sample-api')
   await page.locator('[data-resource="k8s:sample:Deployment:sample-api"]').getByText('1 / 2 Ready · 2 restarts',{exact:true}).waitFor()
   await page.getByRole('complementary',{name:'Детали выбранного ресурса'}).waitFor()
   assert.equal(await page.locator('.logical-details').getByText('UID',{exact:true}).isVisible(),false)
   await page.locator('.logical-details .resource-extra > summary').click()
   await page.locator('.logical-details').getByText('UID',{exact:true}).waitFor()
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),viewport)
   await assertMapLabels(page)
   assert.deepEqual(await page.locator('.logical-edge-label').evaluateAll(nodes=>nodes.map(el=>[el.dataset.edgeLabelId,el.style.transform])),captionPositions,'selection does not move or remount captions')
   await page.locator('.logical-details .resource-extra > summary').click()
   await page.locator('.logical-details').evaluate(el=>{el.scrollTop=0})
   assert.match(await page.locator('.map-dialog-heading').innerText(),/Namespace sample/)
   assert.doesNotMatch(await page.locator('[data-resource="k8s:sample:Deployment:sample-api"] .logical-node-meta').innerText(),/ns sample/)
   assert.match(await page.locator('[data-resource="repo"]').getAttribute('class'),/related/)
   assert.doesNotMatch(await page.locator('[data-resource="image:registry.example/sample-listener"]').getAttribute('class'),/related/)
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),viewport)
   await page.screenshot({path:`${output}/map-${width}-${theme}.png`})
   const canvasBefore=await page.locator('.logical-flow-area').boundingBox()
   fail=true
   await page.locator('.topbar [aria-label="Обновить данные"]').evaluate(element=>element.click())
   await page.getByRole('dialog',{name:'Карта сервиса · sample',exact:true}).getByRole('alert').waitFor()
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),viewport)
   assert.deepEqual(await page.locator('.logical-flow-area').boundingBox(),canvasBefore,'the error message does not move or resize the map')
   fail=false
   await page.getByRole('dialog',{name:'Карта сервиса · sample',exact:true}).getByRole('button',{name:'Повторить',exact:true}).click()
   await page.locator('.map-refresh-error').waitFor({state:'hidden'})
   await selectResource(page,'k8s:sample:Pod:sample-api-hash-pod')
   await selectResource(page,'k8s:sample:Deployment:sample-api')
   const activePath=page.locator('[data-edge-active] .react-flow__edge-path').first()
   assert.equal(await page.getByRole('checkbox',{name:'Анимация связей',exact:true}).count(),0)
   const flowMarker=page.locator('[data-edge-active] .logical-edge-flow').first()
   await flowMarker.waitFor()
   const markerBefore=await flowMarker.evaluate(el=>{const matrix=el.getCTM();return {x:matrix.e,y:matrix.f}})
   await page.waitForTimeout(220)
   const markerAfter=await flowMarker.evaluate(el=>{const matrix=el.getCTM();return {x:matrix.e,y:matrix.f}})
   assert.ok(Math.abs(markerAfter.x-markerBefore.x)+Math.abs(markerAfter.y-markerBefore.y)>1,'the marker moves along the selected edge')
   assert.equal(await flowMarker.locator('animateMotion').getAttribute('repeatCount'),'2')
   assert.ok(parseFloat(await flowMarker.locator('animateMotion').getAttribute('dur'))*2<5,'motion is bounded without a stop control')
   await page.emulateMedia({reducedMotion:'reduce'})
   await page.waitForFunction(()=>document.querySelectorAll('.logical-edge-flow').length===0)
   assert.equal(await activePath.evaluate(el=>getComputedStyle(el).animationName),'none')
   await page.emulateMedia({reducedMotion:'no-preference'})
   await flowMarker.waitFor()
   await page.locator('.logical-details').evaluate(el=>{el.scrollTop=el.scrollHeight})
   await selectResource(page,'k8s:sample:Pod:sample-api-hash-pod')
   assert.equal(await page.locator('.logical-details').evaluate(el=>el.scrollTop),0)
   await page.getByRole('complementary',{name:'Детали выбранного ресурса'}).getByText('containerd://sha256:'+'e'.repeat(64),{exact:true}).waitFor()
   await page.getByRole('button',{name:'Закрыть детали ресурса',exact:true}).click()
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),viewport)
   await selectResource(page,'k8s:sample:Ingress:entry')
   await page.locator('[data-resource="k8s:sample:Ingress:entry"]').getByText('sample.example.test',{exact:true}).waitFor()
   assert.equal(await page.getByRole('complementary',{name:'Детали выбранного ресурса'}).getByRole('link',{name:'sample.example.test/api',exact:true}).getAttribute('href'),'https://sample.example.test/api')
   await selectResource(page,'k8s:sample:Job:sample-migrator-dddddddddddd')
   await page.locator('.logical-details-heading .status').getByText('Argo: Healthy',{exact:true}).waitFor()
   await selectResource(page,'k8s:sample:ExternalSecret:sample-api-runtime')
   assert.match(await page.locator('[data-resource="k8s:sample:Secret:sample-api-runtime"]').getAttribute('class'),/related/)
   assert.match(await page.locator('[data-resource="k8s:sample:Pod:sample-api-hash-pod"]').getAttribute('class'),/related/)
   assert.doesNotMatch(await page.locator('[data-resource="repo"]').getAttribute('class'),/related/)
   assert.doesNotMatch(await page.locator('[data-resource="image:registry.example/sample"]').getAttribute('class'),/related/)
   assert.doesNotMatch(await page.locator('[data-resource="config"]').getAttribute('class'),/related/)
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),viewport)
   assert.match(await page.locator('.logical-neighbors').innerText(),/Published values/)
   await page.screenshot({path:`${output}/secret-highlight-${width}-${theme}.png`})
   await selectResource(page,'k8s:sample:Secret:sample-api-runtime')
   assert.match(await page.locator('[data-resource="vault:vault-services-test:sample/test/runtime"]').getAttribute('class'),/related/)
   assert.doesNotMatch(await page.locator('[data-resource="repo"]').getAttribute('class'),/related/)
   await page.getByRole('button',{name:'Закрыть детали ресурса',exact:true}).click()
   const searchPicker=page.getByRole('combobox',{name:'Выбрать ресурс',exact:true})
   await searchPicker.fill('sample.example.test/api')
   await page.getByRole('option',{name:'entry Ingress',exact:true}).click()
   await page.locator('.logical-details-heading h2').getByText('entry',{exact:true}).waitFor()
   await assertMiniMapPan(page)
   await page.screenshot({path:`${output}/map-fit-${width}-${theme}.png`})
   await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
   await page.getByRole('heading',{name:'Версии и исходники'}).waitFor()
   const mapTrigger=page.getByRole('button',{name:'Показать карту',exact:true})
   for(const input of ['pointer','keyboard']) {
    if(input==='pointer')await mapTrigger.click()
    else {
     await mapTrigger.focus()
     await page.keyboard.press('Tab')
     await page.keyboard.press('Shift+Tab')
     await page.keyboard.press('Enter')
    }
    await page.getByRole('dialog',{name:'Карта сервиса · sample',exact:true}).waitFor()
    if(input==='pointer')await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
    else await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({state:'hidden'})
    await page.waitForTimeout(350)
    assert.equal(await mapTrigger.evaluate(el=>el===document.activeElement),true,'map close restores trigger focus')
    assert.equal(await mapTrigger.locator('.MuiTouchRipple-ripplePulsate,.MuiTouchRipple-childPulsate').count(),0,'restored focus does not pulse')
    assert.equal(await mapTrigger.evaluate(el=>el.getAnimations({subtree:true}).filter(animation=>animation.effect.getTiming().iterations===Infinity).length),0)
    if(input==='keyboard') {
     assert.equal(await mapTrigger.evaluate(el=>el.matches(':focus-visible')),true)
     assert.equal(await mapTrigger.evaluate(el=>getComputedStyle(el).outlineWidth),'2px','keyboard focus remains visible')
    }
   }
   const endpoint=page.getByRole('link',{name:'sample.example.test/api',exact:true})
   assert.equal(await endpoint.getAttribute('href'),'https://sample.example.test/api')
   const contextBounds=await page.locator('.service-context-row').boundingBox(),headingBounds=await page.locator('.service-heading').boundingBox()
   assert.ok(Math.abs(contextBounds.x-headingBounds.x)<2)
   assert.equal(await page.locator('.component-table [data-component]').count(),4)
   assert.equal(await page.locator('.service-heading .env-switch button').count(),2)
   await page.locator('[data-version-field="Source code"]').getByRole('link',{name:'dev',exact:true}).waitFor()
   assert.equal(await page.locator('.service-heading').getByText('Команда не назначена',{exact:true}).count(),0)
   assert.equal(await page.locator('.service-heading').getByText('Project #123',{exact:true}).count(),0)
   assert.equal(await page.locator('[data-version-field="ArgoCD"]').getByText('Synced · Healthy',{exact:true}).count(),0)
   assert.equal(await page.locator('.component-table-problems [data-overview-resource="k8s:sample:Pod:sample-api-hash-pod"]').count(),0)
   runtimeFailure=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('.component-table-problems [data-overview-resource="k8s:sample:Pod:sample-api-hash-pod"]').waitFor()
   runtimeFailure=false
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.waitForFunction(()=>!document.querySelector('.component-table-problems [data-overview-resource="k8s:sample:Pod:sample-api-hash-pod"]'))
   assert.equal(await page.locator('.freshness-badge').count(),0)
   staleSnapshot=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('[data-component="component:api"] .freshness-badge').waitFor()
   await page.screenshot({path:`${output}/stale-overview-${width}-${theme}.png`})
   await mapTrigger.click()
   const staleNode=page.locator('[data-resource="k8s:sample:Deployment:sample-api"]')
   await staleNode.locator('.freshness-badge').getByText('Устарело',{exact:true}).waitFor()
   assert.equal(await staleNode.locator('.logical-node-status').innerText(),'Argo: Progressing')
   assert.ok(await staleNode.locator('.logical-node-footer').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'status and freshness fit on the map card')
   await selectResource(page,'k8s:sample:Deployment:sample-api')
   await page.locator('.logical-details-heading .freshness-badge').getByText('Данные устарели',{exact:true}).waitFor()
   await page.screenshot({path:`${output}/stale-map-${width}-${theme}.png`})
   await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
   staleSnapshot=false
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.waitForFunction(()=>!document.querySelector('.freshness-badge'))
   assert.equal(await page.locator('.workspace').count(),0)
   await page.getByRole('tab',{name:'Overview',exact:true}).focus()
   await page.keyboard.press('ArrowRight')
   await page.getByRole('tab',{name:'History',exact:true}).waitFor()
   assert.equal(await page.getByRole('tab',{name:'History',exact:true}).getAttribute('aria-selected'),'true')
   await page.getByRole('heading',{name:'Выкат подтвержден',exact:true}).waitFor()
   assert.equal(await page.locator('.history-operation').count(),1)
   assert.doesNotMatch(await page.locator('.history-heading').innerText(),/событий/)
   assert.equal(await page.getByRole('link',{name:'Job #310',exact:true}).getAttribute('href'),'https://git.example/team/deployments/-/jobs/310')
   assert.equal(await page.getByRole('link',{name:'Pipeline #31',exact:true}).getAttribute('href'),'https://git.example/team/deployments/-/pipelines/31')
   await page.locator('.history-operation-details > summary').click()
   assert.equal(await page.locator('.history-steps').first().locator('li').count(),6)
   assert.match(await page.locator('.history-operation-meta time').getAttribute('datetime'),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
   assert.match(await page.locator('.history-operation-meta time').innerText(),/\d{2}:\d{2}:\d{2}/)
   await page.getByText('Длительность',{exact:false}).first().waitFor()
   assert.match(await page.locator('.history-steps').first().innerText(),/Publication · 5s/)
   assert.match(await page.locator('.history-steps').first().innerText(),/Deploy verification · 24s/)
   assert.match(await page.locator('.history-steps').first().innerText(),/Argo sync · 15s/)
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.waitForTimeout(400)
   assert.equal(await page.locator('.history-operation-details').getAttribute('open'),'')
   await page.screenshot({path:`${output}/history-${width}-${theme}.png`})
   await page.locator('.history-archive > summary').click()
   await page.getByRole('link',{name:'История feature/stopped',exact:true}).click()
   await page.waitForURL(url=>url.searchParams.get('instance')==='old-feature'&&url.searchParams.get('tab')==='history')
   await page.getByRole('heading',{name:'Feature-окружение удалено',exact:true}).waitFor()
   await page.getByRole('button',{name:'Показать более ранние события',exact:true}).click()
   await page.getByRole('heading',{name:'Образ готов',exact:true}).waitFor()
   assert.equal(await page.getByRole('button',{name:'Показать более ранние события',exact:true}).count(),0)
   await page.screenshot({path:`${output}/archive-${width}-${theme}.png`})
   await page.reload()
   await page.getByRole('heading',{name:'Feature-окружение удалено',exact:true}).waitFor()
   assert.match(page.url(),/instance=old-feature/)
   await page.locator('.service-heading').getByRole('button',{name:'test',exact:true}).click()
   await page.getByRole('heading',{name:'Выкат подтвержден',exact:true}).waitFor()
   await page.getByRole('tab',{name:'History',exact:true}).focus()
   await page.keyboard.press('ArrowLeft')
   await page.getByRole('heading',{name:'Версии и исходники'}).waitFor()
   await page.getByRole('link',{name:'Build #300, failed, dev'}).waitFor()
   await page.locator('.ci-attempts .ci-context-label').getByText('Latest CI runs',{exact:true}).waitFor()
   assert.match(await page.getByRole('link',{name:'Build #300, failed, dev'}).getAttribute('href'),/team\/sample\/-\/jobs\/300$/)
   await page.screenshot({path:`${output}/overview-${width}-${theme}.png`})
   const componentRoute=page.url()
   await page.getByRole('button',{name:'worker',exact:true}).click()
   assert.equal(await page.getByRole('button',{name:'worker',exact:true}).getAttribute('aria-expanded'),'true')
   assert.equal(page.url(),componentRoute)
   await page.reload()
   await page.getByRole('heading',{name:'Версии и исходники'}).waitFor()
   assert.match(page.url(),/service=sample/)
   assert.equal(await page.getByText('Build passed',{exact:true}).count(),0)
   await page.getByRole('button',{name:'Все сервисы',exact:true}).click()
   catalogExtra=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.waitForTimeout(350)
   assert.equal(await page.locator('[data-service="automatically-added"]').count(),0)
   assert.equal(await page.locator('[data-service="absent-service"],[data-service="stopped-service"]').count(),0)
   assert.equal(await page.locator('.catalog-controls .env-switch').count(),0)
   assert.equal(await page.getByRole('group',{name:'Глобальное окружение'}).getByRole('button',{name:'test',exact:true}).getAttribute('aria-pressed'),'true')
   assert.equal(await page.getByRole('combobox',{name:'Наличие окружения',exact:true}).count(),0)
   const globalEnvironments=page.getByRole('group',{name:'Глобальное окружение'})
   assert.equal(await globalEnvironments.getByRole('button',{name:'preprod',exact:true}).count(),0)
   publishedEnvironments=['test','preprod','feature']
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await globalEnvironments.getByRole('button',{name:'preprod',exact:true}).click()
   publishedEnvironments=['test','feature']
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.waitForURL(url=>!url.searchParams.has('env'))
   assert.equal(await globalEnvironments.getByRole('button',{name:'preprod',exact:true}).count(),0)
   catalogDeployed=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('[data-service="automatically-added"]').waitFor()
   const serviceCard=page.locator('[data-service="sample"] .catalog-service-link')
   assert.equal(await serviceCard.evaluate(el=>el.tagName),'A')
   assert.match(await serviceCard.getAttribute('href'),/service=sample/)
   const [catalogTab]=await Promise.all([context.waitForEvent('page'),serviceCard.click({modifiers:['Control']})])
   await catalogTab.waitForURL(url=>url.searchParams.get('service')==='sample')
   assert.match(catalogTab.url(),/service=sample/)
   await catalogTab.close()
   await page.screenshot({path:`${output}/catalog-${width}-${theme}.png`})
   await page.locator('[data-service="sample"]').click()
   await page.locator('.service-heading').getByRole('button',{name:'feature',exact:true}).click()
   await page.locator('.feature-context .feature-age').getByText('Uptime 1d 0h',{exact:true}).waitFor()
   await page.waitForURL(url=>url.searchParams.get('instance')==='feature-two') // Stable alphabetical branch order.
   await page.getByRole('combobox',{name:'Feature-окружение',exact:true}).click()
   assert.equal(await page.getByRole('option').count(),2)
   assert.equal(await page.getByRole('option',{name:/stopped/}).count(),0)
   assert.ok((await page.getByRole('option').first().boundingBox()).height<=52)
   assert.ok(await page.locator('.feature-option strong').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize))<=12)
   assert.ok((await page.locator('.feature-menu').boundingBox()).width<=602)
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('.feature-menu')).opacity==='1')
   await page.screenshot({path:`${output}/feature-menu-${width}-${theme}.png`})
   await page.getByRole('option',{name:/feature\/topic/}).click()
   await page.waitForURL(url=>url.searchParams.get('instance')==='feature-one')
   await page.locator('.feature-stop').getByText(/Auto-stop через/).waitFor()
   duplicateBranches=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('.feature-instance-hint').waitFor()
   const firstHint=await page.locator('.feature-context .feature-instance-hint').innerText()
   await page.getByRole('combobox',{name:'Feature-окружение',exact:true}).click()
   await page.getByRole('option').filter({has:page.getByText(/…ture-two/)}).click()
   await page.waitForURL(url=>url.searchParams.get('instance')==='feature-two')
   assert.notEqual(await page.locator('.feature-context .feature-instance-hint').innerText(),firstHint)
   await page.getByRole('button',{name:'Показать карту',exact:true}).click()
   assert.match(await page.locator('.map-dialog-heading').innerText(),/feature\/topic · ture-two/)
   await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
   duplicateBranches=false
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=feature-one')
   await page.reload()
   await page.locator('.feature-context').getByText(feature.source_ref,{exact:true}).waitFor()
   assert.match(page.url(),/instance=feature-one/)
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=missing-feature')
   await page.getByRole('combobox',{name:'Feature-окружение',exact:true}).click()
   await page.getByRole('option',{name:/feature\/topic/}).click()
   await page.waitForURL(url=>url.searchParams.get('instance')==='feature-one')
   await page.getByRole('button',{name:'Sources',exact:true}).click()
   assert.equal(await page.getByRole('heading',{name:'Sources',exact:true}).count(),1)
   await page.locator('.source-diagnostics-gate').getByText(/Запрос разрешен не раньше/).waitFor()
   await page.locator('.source-diagnostics-extra > summary').click()
   assert.match(await page.locator('.source-diagnostics-extra').innerText(),/30 \/ 30/)
   await page.screenshot({path:`${output}/sources-${width}-${theme}.png`})
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=feature-one')
   manyFeatures=false
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('.feature-branch-chip').waitFor()
   assert.equal(await page.getByRole('combobox',{name:'Feature-окружение',exact:true}).count(),0)
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=old-feature')
   await page.getByRole('button',{name:'Открыть feature/topic',exact:true}).click()
   await page.waitForURL(url=>url.searchParams.get('instance')==='feature-one')
   await page.goto(root+'/?page=service&service=sample&view=map&resource=k8s:sample:Pod:already-gone')
   await page.getByText('Ресурс не найден в текущем снимке',{exact:true}).waitFor()
   assert.equal(await page.locator('.logical-node.dimmed,[data-edge-active]').count(),0,'an unknown resource does not dim the entire map')
   const missingViewport=await page.locator('.react-flow__viewport').getAttribute('style')
   await page.getByRole('button',{name:'Сбросить выделение',exact:true}).click()
   assert.equal(new URL(page.url()).searchParams.has('resource'),false)
   assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),missingViewport)
   await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
   await page.getByRole('button',{name:'Activity',exact:true}).click()
   await page.locator('.history-operation').filter({hasText:'v1.2.3'}).getByRole('link',{name:'sample',exact:true}).click()
   await page.getByRole('heading',{name:'История ветки v1.2.3',exact:true}).waitFor()
   assert.equal(new URL(page.url()).searchParams.has('env'),false)
   assert.equal(new URL(page.url()).searchParams.has('instance'),false)
   await page.locator('.history-operation').first().waitFor()
   assert.equal(await page.locator('.history-operation').count(),1)
   await page.reload()
   await page.getByRole('heading',{name:'История ветки v1.2.3',exact:true}).waitFor()
   await page.locator('.service-heading').getByRole('button',{name:'feature',exact:true}).click()
   await page.getByText('История всех feature-экземпляров',{exact:true}).waitFor()
   assert.equal(new URL(page.url()).searchParams.has('history_ref'),false)
   assert.equal(await page.getByText(/нет подтвержденного Application/).count(),0)
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=feature-one')
   await page.getByRole('heading',{name:'Версии и исходники'}).waitFor()
   fail=true
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.getByRole('alert').waitFor()
   await page.getByRole('heading',{name:'Версии и исходники'}).waitFor()
   await page.goto(root+'/')
   await page.getByRole('heading',{name:'Каталог недоступен',exact:true}).waitFor()
   assert.equal(await page.getByText('Каталог пока пуст',{exact:true}).count(),0)
   assert.doesNotMatch(await page.getByRole('alert').innerText(),/последний снимок/)
   await page.getByRole('button',{name:'Sources',exact:true}).click()
   await page.getByText('Не удалось загрузить источники. Повторите попытку.',{exact:true}).waitFor()
   fail=false
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.locator('.source-diagnostics-gate').waitFor()
   fail=false;signedIn=false
   await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
   await page.getByRole('link',{name:'Войти через Authentik'}).waitFor()
   assert.equal(await page.locator('.developer-overview').count(),0)
   assert.deepEqual(errors,[])
   console.log(JSON.stringify({width,theme,zoom,passed:true,checks:['login gate','deep link reload','dynamic environment inventory','present services only','four components','no sibling image trace','compact feature dropdown/chips','keyboard tabs','minimap bounded pan at .95/1.8','stable viewport and captions','labels outside cards','bounded motion and reduced motion','unknown resource link recovery','targetless build history_ref reload','generic feature history','first503 recovery','503 retains data','401 hides data']}))
   await context.close()
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
