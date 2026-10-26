const {chromium,webkit}=require(process.env.SDM_PLAYWRIGHT_MODULE||'playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const root=process.env.SDM_BROWSER_URL||'http://host.docker.internal:4376',out=process.env.SDM_BROWSER_ARTIFACTS||'/artifacts'
const fixtureSource=fs.readFileSync(path.join(__dirname,'live-browser.cjs'),'utf8').split(';(async()=>')[0]
const fixture=new Function('require','process',fixtureSource+';return {base,instance,feature,featureTwo,stoppedFeature,summary,links,latestAttempts}')(require,process)
async function inspect(page){
 return page.evaluate(()=>{
  const canvas=document.createElement('canvas'),c=canvas.getContext('2d')
  canvas.width=canvas.height=1
  const rgb=value=>{c.clearRect(0,0,1,1);c.fillStyle=value;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data]}
  const lum=rgb=>rgb.slice(0,3).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0)
  const rows=[]
  for(const area of document.querySelectorAll('.service-catalog-card,.compact-service-heading,.ci-context,.service-common,.compact-components,.service-technical'))for(const el of area.querySelectorAll('a,button,span,h1,h2,h3,dt,dd,th,td,code,summary,small')){
   if(!el.getClientRects().length||![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue
   const style=getComputedStyle(el);if(style.visibility==='hidden')continue
   let parent=el,bg
   while(parent){bg=rgb(getComputedStyle(parent).backgroundColor);if(bg[3]>250)break;parent=parent.parentElement}
   if(!bg||bg[3]<250)continue
   const a=lum(rgb(style.color)),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05)
   rows.push({text:el.textContent.trim().slice(0,80),ratio,size:parseFloat(style.fontSize)})
  }
  return {overflow:document.documentElement.scrollWidth>innerWidth+1,rows}
 })
}
;(async()=>{
 const {resourceGraph}=await import('../src/data.ts'),report={url:root,cases:[],errors:[],failures:[],links:[],technicalFields:[]}
 fs.mkdirSync(out,{recursive:true})
 for(const engine of ['chromium','webkit']){
  const browser=await({chromium,webkit}[engine]).launch()
  try{
   for(const width of engine==='chromium'?[1024,1280,1440,1512]:[1512])for(const mode of ['dark','light'])for(const palette of ['orange','cobalt','signal']){
    if(process.env.SDM_BROWSER_CASE&&process.env.SDM_BROWSER_CASE!==[engine,width,mode,palette].join(':'))continue
    const context=await browser.newContext({viewport:{width,height:982},colorScheme:mode,reducedMotion:'reduce'}),page=await context.newPage()
    page.on('pageerror',e=>report.errors.push(e.message))
    await page.addInitScript(prefs=>localStorage.setItem('delivery-monitor-ui',JSON.stringify(prefs)),{mode,palette})
    const {base,instance,feature,featureTwo,stoppedFeature,summary,links,latestAttempts}=structuredClone(fixture)
    instance.observations.test.git.config_ref='master'
    instance.observations.test.git.config_managed_files=instance.observations.test.git.workloads.flatMap(workload=>workload.config_files)
    instance.observations.test.git.build_job='100'
    instance.observations.test.git.publisher_pipeline='200'
    const ci={project:'platform/ci-cd',ref:'v3.0.0',revision:'e'.repeat(40)}
    summary.ci=ci;instance.observations.test.git.ci=ci
    const release={tag:'v1.2.3',version:'1.2.3',operation:'a'.repeat(64),revision:'e'.repeat(40)}
    const prod=structuredClone(instance);prod.id='sample:prod:sample';prod.environment='prod';prod.observations.test.values_path='kubernetes/prod/sample/values.yaml';prod.observations.test.values_revision='9'.repeat(40);prod.observations.test.git.release=release
    feature.observations.test.values_path='kubernetes/feature/'+feature.name+'/values.yaml';feature.observations.test.values_revision='8'.repeat(40)
    const catalog=[{...base,instances:[summary,{...summary,id:prod.id,environment:'prod',release},{...summary,id:feature.id,name:feature.name,environment:'feature',source_ref:feature.source_ref},{...summary,id:featureTwo.id,name:featureTwo.name,environment:'feature',source_ref:featureTwo.source_ref}]},...['second-service','a-very-long-service-name-with-many-components'].map((key,i)=>({...base,key,project:'team/'+key,project_id:124+i,instances:[{...summary,id:key+':test:'+key,name:key}]}))]
    const detail={service:base,instances:[instance,prod,feature,featureTwo,stoppedFeature],latest_attempts:latestAttempts}
    latestAttempts.push({...structuredClone(latestAttempts[1]),key:'sample:test:sample:deployment',payload:{...structuredClone(latestAttempts[1].payload),kind:'deployment',attempt:{pipeline_id:31,job_id:311}}})
    let sourceItems=[]
    await context.route('**/auth/session',r=>r.fulfill({json:{user:{sub:'fixture',name:'Fixture viewer',email:'viewer@example.test',role:'viewer'},sso_enabled:true}}))
    await context.route('**/api/v1/**',r=>{const p=new URL(r.request().url()).pathname;return r.fulfill({json:p==='/api/v1/services'?{items:catalog,environments:['test','prod','feature'],links}:p==='/api/v1/services/sample'?detail:p==='/api/v1/sources'?{items:sourceItems}:{items:[]}})})
    await context.route('https://git.example/**',r=>r.fulfill({body:'Synthetic GitLab resource'}))
    await page.goto(root+'/?env=test');await page.locator('[data-service="sample"]').waitFor();await page.evaluate(()=>document.fonts.ready)
    const cards=await page.locator('.service-catalog-card').evaluateAll(es=>es.map(el=>{const name=el.querySelector('h2').getBoundingClientRect(),env=el.querySelector('.catalog-environment-name').getBoundingClientRect();return {height:el.getBoundingClientRect().height,envRight:env.x>name.right,aligned:Math.abs(env.y+env.height/2-name.y-name.height/2)<2}}))
    assert(cards.every(c=>c.height<225&&c.envRight&&c.aligned),JSON.stringify(cards))
    assert.equal(await page.locator('a a').count(),0)
    const repo=page.locator('[data-service="sample"] .catalog-repository');assert.equal(await repo.getAttribute('href'),'https://git.example/team/sample');assert.equal(await repo.getAttribute('target'),'_blank')
    const cardHref=await page.locator('[data-service="sample"] .catalog-service-link').getAttribute('href');assert.match(cardHref,/page=service/);assert.match(cardHref,/service=sample/)
    const facts=page.locator('[data-service="sample"] .catalog-compact-facts > div')
    const ciLink=facts.filter({hasText:'CI/CD'}).getByRole('link');assert.equal(await ciLink.getAttribute('href'),'https://git.example/platform/ci-cd/-/tree/v3.0.0')
    const chartLink=facts.filter({hasText:'Chart'}).getByRole('link')
    const catalogChartHref=await chartLink.getAttribute('href')
    assert.equal(catalogChartHref,'https://git.example/team/service-chart/-/tree/v1.2.3')
    if(width===1280&&mode==='dark'&&palette==='orange'){
     const opened=context.waitForEvent('page');await chartLink.click();const chartPage=await opened;await chartPage.waitForURL(catalogChartHref);await chartPage.close()
     await page.getByRole('group',{name:'Глобальное окружение',exact:true}).getByRole('button',{name:'feature',exact:true}).click();await chartLink.waitFor()
     assert.equal(await chartLink.getAttribute('href'),'https://git.example/team/service-chart/-/tree/v1.2.3')
     const other=catalog[0].instances.find(i=>i.id===featureTwo.id),originalRepo=other.chart_repo
     other.chart_repo='https://git.example/another/chart.git'
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await chartLink.waitFor({state:'detached'})
     other.chart_repo=originalRepo
     const originalRef=other.chart_ref;delete other.chart_ref
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click()
     await facts.filter({hasText:'Chart'}).getByText('Нет данных',{exact:true}).waitFor()
     assert.equal(await facts.filter({hasText:'Chart'}).getByRole('link').count(),0)
     other.chart_ref=originalRef
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await chartLink.waitFor()
     await page.getByRole('group',{name:'Глобальное окружение',exact:true}).getByRole('button',{name:'test',exact:true}).click()
    }
    await page.getByRole('group',{name:'Глобальное окружение',exact:true}).getByRole('button',{name:'prod',exact:true}).click()
    const releaseLink=page.locator('[data-service="sample"] .catalog-release-tag a');await releaseLink.waitFor()
    assert.equal(await releaseLink.getAttribute('href'),'https://git.example/team/sample/-/tags/v1.2.3')
    const prodHeight=await page.locator('[data-service="sample"]').evaluate(el=>el.getBoundingClientRect().height)
    assert(Math.abs(prodHeight-cards[0].height)<1,JSON.stringify({test:cards[0].height,prod:prodHeight}))
    assert.equal(await page.locator('.catalog-release').count(),0)
    if(width===1280&&mode==='dark'&&palette==='orange')await page.screenshot({path:path.join(out,'catalog-prod-1280.png'),fullPage:true})
    await page.getByRole('group',{name:'Глобальное окружение',exact:true}).getByRole('button',{name:'test',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('.catalog-release-tag'))
    for(const hover of [false,true]){
     if(hover)await page.locator('[data-service="sample"]').hover()
     const check=await inspect(page),fail=check.rows.filter(r=>r.ratio<4.5&&!(r.size>=24&&r.ratio>=3))
     assert(!check.overflow);if(fail.length)report.failures.push({area:'catalog',engine,width,mode,palette,hover,fail})
    }
    if(width===1280&&mode==='dark'&&palette==='orange')await page.screenshot({path:path.join(out,'catalog-1280.png'),fullPage:true})
    if(width===1280&&mode==='dark'&&palette==='orange'){
     catalog[0].instances[0].runtime.truncated=true;instance.observations.test.runtime.truncated=true
     const pod=instance.observations.test.runtime.objects.find(object=>object.uid==='pod')
     const otherImage=instance.observations.test.git.images.find(image=>image.repository.endsWith('-listener'))
     otherImage.digest='sha256:'+'b'.repeat(64)
     pod.images.push({name:'setup',image:otherImage.repository+'@'+otherImage.digest,init:true})
     pod.containers.push({name:'setup',image_id:'containerd://sha256:'+'b'.repeat(64),init:true,ready:true,restarts:0})
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.locator('[data-service="sample"] .partial-observation').waitFor()
     assert.match(await page.locator('[data-service="sample"] .catalog-card-status').innerText(),/Synced · Healthy/)
     const popupPromise=context.waitForEvent('page');await page.locator('[data-service="sample"] .catalog-service-link').click({modifiers:['Control']});const popup=await popupPromise;await popup.waitForURL(u=>u.searchParams.get('service')==='sample');await popup.close()
     await page.locator('[data-service="sample"]').click()
    }else await page.locator('[data-service="sample"] .catalog-service-link').click()
    await page.locator('.service-common').waitFor()
    if(width===1280&&mode==='dark'&&palette==='orange')assert.equal(await page.locator('.service-observation-times .partial-observation').count(),1)
    assert.match(await page.locator('.service-observation-times').innerText(),/ArgoCD:/)
    assert.equal(await page.locator('.service-version-icon [data-system="helm"]').count(),1)
    assert.equal(await page.locator('[data-version-field="Helm chart"] a').getAttribute('href'),catalogChartHref)
    const spacing=await page.locator('.service-version-row').evaluateAll(es=>es.map(el=>{const icon=el.querySelector('.service-version-icon').getBoundingClientRect(),label=el.querySelector('.service-version-label').getBoundingClientRect(),value=el.querySelector('.service-version-value').getBoundingClientRect();return {icon:label.left-icon.right,value:value.left-label.right,align:getComputedStyle(el.querySelector('.service-version-label')).textAlign}}))
    assert(spacing.every(s=>Math.abs(s.icon-6)<.1&&Math.abs(s.value-12)<.1&&s.align==='left'),JSON.stringify(spacing))
    const source=page.locator('[data-version-field="Source code"]');assert.equal(await source.getByRole('link',{name:'dev',exact:true}).getAttribute('href'),'https://git.example/team/sample/-/tree/dev')
    for(const [label,name,href] of [
     ['Source code','dev','https://git.example/team/sample/-/tree/dev'],
     ['Helm chart','v1.2.3','https://git.example/team/service-chart/-/tree/v1.2.3'],
     ['App config','master','https://git.example/config/test/-/tree/master'],
     ['Generated values','values.yaml','https://git.example/team/deployments/-/blob/'+'c'.repeat(40)+'/kubernetes/test/sample/values.yaml'],
     ['ArgoCD','sample','https://argo.example/applications/argocd/sample'],
    ]){
     const row=page.locator(`[data-version-field="${label}"]`)
     assert.equal(await row.getByRole('link').count(),1,label)
     assert.equal(await row.getByRole('link',{name,exact:true}).getAttribute('href'),href,label)
     assert.equal(await row.getByRole('button').count(),1,label+' map action preserved')
    }
    const linkStyle=await source.getByRole('link').evaluate(el=>({underline:getComputedStyle(el.querySelector('span')).textDecorationLine,color:getComputedStyle(el).color,arrow:getComputedStyle(el.querySelector('svg')).color,gap:getComputedStyle(el).columnGap}))
    assert.equal(linkStyle.underline,'none');assert.equal(linkStyle.gap,'4px');assert.notEqual(linkStyle.color,linkStyle.arrow)
    await source.getByRole('link').hover()
    assert.equal(await source.getByRole('link').evaluate(el=>getComputedStyle(el.querySelector('span')).textDecorationLine),'underline')
    await page.mouse.move(2,2)
    assert.equal(await page.locator('[data-version-field="Release"]').count(),0)
    assert.equal(await page.locator('[data-version-field="CI/CD"] a').getAttribute('href'),'https://git.example/platform/ci-cd/-/tree/v3.0.0')
    const iconGaps=await page.locator('.ci-context a.sheet-value-link').evaluateAll(links=>links.map(link=>{const text=link.querySelector('span').getBoundingClientRect(),icon=link.querySelector('svg').getBoundingClientRect();return {label:link.textContent,gap:icon.left-text.right}}))
    assert.equal(iconGaps.length,5)
    assert(iconGaps.every(item=>Math.abs(item.gap-4)<.1),JSON.stringify(iconGaps))
    const inputs=page.locator('[data-version-field="Source values"]');assert.deepEqual(await inputs.locator('.source-values-files small').allTextContents(),['Common','test']);assert.equal(await inputs.locator('.source-values-files a').count(),2)
    const built=page.locator('[data-version-field="Build"] a');assert.equal(await built.getAttribute('href'),'https://git.example/team/sample/-/tree/'+ 'e'.repeat(40))
    assert.equal((await page.locator('.ci-attempts .ci-stage').first().innerText()).trim(),'Build #300')
    assert.match(await page.locator('.ci-attempts .ci-stage').first().getAttribute('aria-label'),/failed, dev/)
    assert.doesNotMatch(await page.locator('.ci-context').innerText(),/Image совпадает|Из Argo\/values|ветка dev|Build dev/)
    const metrics=page.locator('[data-component="component:api"] .component-readiness');assert.match(await metrics.innerText(),/1 \/ 2 Ready/);assert(await metrics.evaluate(el=>el.classList.contains('tone-warn')))
    if(width===1280&&mode==='dark'&&palette==='orange')assert.equal(await page.locator('[data-component="component:api"] .component-images-toggle').innerText(),'2 images')
    await page.locator('[data-component="component:api"] .component-row-toggle').click();await page.locator('.component-expanded:not([hidden])').waitFor();assert(await page.locator('.component-expanded:not([hidden]) [data-overview-resource]').count()>3)
    await page.locator('[data-component="component:api"] .component-row-toggle').click()
    const overview=await inspect(page);assert(!overview.overflow);const overviewFailures=overview.rows.filter(r=>r.ratio<4.5&&!(r.size>=24&&r.ratio>=3));if(overviewFailures.length)report.failures.push({area:'overview',engine,width,mode,palette,fail:overviewFailures})
    {
     const dimensions=await page.locator('.service-version-grid,.compact-service-heading').evaluateAll(es=>es.map(el=>el.getBoundingClientRect().height))
     await page.locator('.env-switch').getByRole('button',{name:'prod',exact:true}).click()
     const tagLink=page.locator('.service-heading-release a');await tagLink.waitFor()
     const generated=page.locator('[data-version-field="Generated values"]')
     assert.equal(await generated.getByRole('link').count(),1)
     assert.equal(await generated.getByRole('link',{name:'values.yaml',exact:true}).getAttribute('href'),'https://git.example/team/deployments/-/blob/'+'9'.repeat(40)+'/kubernetes/prod/sample/values.yaml')
     assert.equal(await generated.getByRole('link',{name:'main',exact:true}).count(),0)
     assert.equal(await tagLink.getAttribute('href'),'https://git.example/team/sample/-/tags/v1.2.3')
     assert.equal((await tagLink.innerText()).trim(),'Release v1.2.3')
     assert.equal(await page.locator('[data-version-field="Release"]').count(),0)
     const prodDimensions=await page.locator('.service-version-grid,.compact-service-heading').evaluateAll(es=>es.map(el=>el.getBoundingClientRect().height))
     assert(prodDimensions.every((height,index)=>Math.abs(height-dimensions[index])<1),JSON.stringify({dimensions,prodDimensions}))
     if(width===1280&&mode==='dark'&&palette==='orange'){
      await page.screenshot({path:path.join(out,'overview-prod-1280.png'),fullPage:true})
      const opened=context.waitForEvent('page');await tagLink.click();const linkedPage=await opened;await linkedPage.waitForURL('https://git.example/team/sample/-/tags/v1.2.3');await linkedPage.close()
     }
     await page.locator('.env-switch').getByRole('button',{name:'test',exact:true}).click()
     await page.waitForFunction(()=>!document.querySelector('.service-heading-release'))
    }
    if(width===1280&&mode==='dark'&&palette==='orange'){
     await page.goto(root+'/?page=service&service=sample&env=feature&instance='+feature.name)
     const generated=page.locator('[data-version-field="Generated values"]');await generated.waitFor()
     assert.equal(await generated.getByRole('link').count(),1)
     assert.equal(await generated.getByRole('link',{name:'values.yaml',exact:true}).getAttribute('href'),'https://git.example/team/deployments/-/blob/'+'8'.repeat(40)+'/kubernetes/feature/'+feature.name+'/values.yaml')
     const opened=context.waitForEvent('page');await generated.getByRole('link').click();const valuesPage=await opened;await valuesPage.waitForURL('https://git.example/team/deployments/-/blob/'+'8'.repeat(40)+'/kubernetes/feature/'+feature.name+'/values.yaml');await valuesPage.close()
     await page.goto(root+'/?page=service&service=sample&env=test');await page.locator('.service-common').waitFor()
    }
    if(width===1280&&mode==='dark'&&palette==='orange'){
     await page.screenshot({path:path.join(out,'overview-1280.png'),fullPage:true})
     await inputs.getByRole('button',{name:'Показать на карте: deploy/values-test.yaml',exact:true}).click();await page.locator('.logical-details').waitFor();assert.equal(new URL(page.url()).searchParams.get('resource'),'sourceValues');await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
    }
    await page.getByRole('tab',{name:'Технические данные',exact:true}).click();await page.locator('.service-technical').waitFor()
    const graph=resourceGraph(base,instance,links),expected=Object.values(graph.data).reduce((sum,r)=>sum+r.fields.filter(([,v])=>typeof v==='string'&&v!=='').length,0)
    assert.equal(await page.locator('.service-technical [data-field-name]').count(),expected)
    const fields=await page.locator('.service-technical [data-resource-id]').evaluateAll(es=>es.flatMap(el=>[...el.querySelectorAll('[data-field-name]')].map(field=>({id:el.dataset.resourceId,name:field.dataset.fieldName,href:field.querySelector('dd a')?.getAttribute('href')}))))
    for(const field of fields)assert.equal(field.href||undefined,graph.data[field.id].fieldLinks?.[field.name])
    for(const group of await page.locator('.technical-field-group').all())await group.locator('summary').click()
    const technical=await inspect(page);assert(!technical.overflow);const technicalFailures=technical.rows.filter(r=>r.ratio<4.5&&!(r.size>=24&&r.ratio>=3));if(technicalFailures.length)report.failures.push({area:'technical',engine,width,mode,palette,fail:technicalFailures})
    report.technicalFields.push({engine,width,mode,palette,expected,displayed:fields.length})
    if(width===1280&&mode==='dark'&&palette==='orange'){
     await page.reload();await page.locator('.service-technical').waitFor();assert.equal(new URL(page.url()).searchParams.get('tab'),'technical')
     await page.getByRole('tab',{name:'History',exact:true}).click();await page.locator('.history-panel').waitFor();await page.locator('.history-archive>summary').click();await page.getByRole('link',{name:'История feature/stopped',exact:true}).click();await page.waitForURL(u=>u.searchParams.get('instance')==='old-feature');await page.reload();await page.locator('.history-panel').waitFor();assert.match(await page.locator('.service-argo-state').innerText(),/Stopped/);assert.equal(new URL(page.url()).searchParams.get('tab'),'history')
     sourceItems=[{name:'argo-prod',kind:'argocd',interval_seconds:600,last_success_at:Date.now()/1000,last_attempt_at:Date.now()/1000,failures:0,error_code:'partial_application_failure',application_errors:[{application:'pending-application',code:'unresolved_values_revision'}],last_application_error:{application:'pending-application',code:'unresolved_values_revision',checked_at:Date.now()/1000}}]
     await page.getByRole('navigation',{name:'Главная навигация',exact:true}).getByRole('button',{name:'Sources',exact:true}).click()
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.locator('.source-diagnostics-error li').waitFor()
     assert.match(await page.locator('.source-diagnostics-error li').innerText(),/pending-application.*unresolved_values_revision/)
     assert.match(await page.locator('p.source-diagnostics-error').innerText(),/не означает ошибку Sync/)
     await page.locator('.source-diagnostics-extra summary').click();assert.match(await page.locator('.source-diagnostics-extra').innerText(),/Последний сбой Application/)
     await page.screenshot({path:path.join(out,'source-failure-1280.png'),fullPage:true})
     sourceItems[0].error_code=null;sourceItems[0].application_errors=[]
     await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.source-diagnostics-error'))
     assert.match(await page.locator('.source-diagnostics-extra').innerText(),/pending-application/)
     delete instance.observations.test.chart_ref
     await page.goto(root+'/?page=service&service=sample&env=test');await page.locator('[data-version-field="Helm chart"]').waitFor()
     const chartFallback=page.locator('[data-version-field="Helm chart"]')
     assert.equal(await chartFallback.getByRole('link').count(),1)
     assert.equal(await chartFallback.getByRole('link',{name:'service-chart',exact:true}).getAttribute('href'),'https://git.example/team/service-chart')
    }
    report.cases.push({engine,width,mode,palette,maxCardHeight:Math.max(...cards.map(c=>c.height)),minimumContrast:Math.min(...overview.rows.map(r=>r.ratio))})
    await context.close()
   }
  }finally{await browser.close()}
 }
 fs.writeFileSync(path.join(out,process.env.SDM_BROWSER_CASE?'compact-ui-case.json':'compact-ui-report.json'),JSON.stringify(report,null,2));assert.deepEqual(report.errors,[]);assert.equal(report.failures.length,0,'Contrast findings saved in UI report');console.log(JSON.stringify({cases:report.cases.length,errors:report.errors,min:Math.min(...report.cases.map(c=>c.minimumContrast)),maxCardHeight:Math.max(...report.cases.map(c=>c.maxCardHeight)),technicalChecks:report.technicalFields.length}))
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1})
