const {chromium}=require(process.env.SDM_PLAYWRIGHT_MODULE||'playwright')
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const root=process.env.SDM_BROWSER_URL||'http://host.docker.internal:4329'
const fixtureSource=fs.readFileSync(path.join(__dirname,'live-browser.cjs'),'utf8').split(';(async()=>')[0]
const {base,instance,summary,links}=new Function('require','process',fixtureSource+';return {base,instance,summary,links}')(require,process)
;(async()=>{
 const browser=await chromium.launch({headless:true}),checks=[]
 try{
  const page=await browser.newPage(),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.clock.install()
  await page.addInitScript(()=>{window.probeHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.probeHidden})})
  let version=1,calls=0,held=null,holdNext=false
  await page.route('**/probe/*',async route=>{calls++;if(holdNext){holdNext=false;held=route;return}await route.fulfill({json:{version}})})
  const settled=async expected=>{await page.waitForFunction(v=>{const s=JSON.parse(document.querySelector('#poll-state').textContent);return !s.loading&&s.data?.version===v},expected,{timeout:2500});return JSON.parse(await page.locator('#poll-state').textContent())}
  await page.goto(root+'/tests/api-probe.html');await settled(1)
  version=2;await page.clock.fastForward(31000);await settled(2);checks.push('visible interval updates without refresh')
  await page.evaluate(()=>{window.probeHidden=true;document.dispatchEvent(new Event('visibilitychange'))})
  const beforeHidden=calls;await page.clock.fastForward(90000);assert.equal(calls,beforeHidden)
  version=3;await page.evaluate(()=>{window.probeHidden=false;document.dispatchEvent(new Event('visibilitychange'))});await settled(3);checks.push('visible tab resumes immediately')
  await page.clock.fastForward(1100);version=4;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await settled(4);checks.push('window focus resumes immediately')
  await page.clock.fastForward(1100);version=5;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await settled(5);checks.push('online resumes immediately')
  await page.clock.fastForward(1100);holdNext=true;version=6;const beforeBurst=calls
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'))})
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#poll-state').textContent).loading)
  assert.equal(calls,beforeBurst+1);assert(held);await held.fulfill({json:{version}});held=null;await settled(6);checks.push('resume events share one request')
  await page.clock.fastForward(1100);holdNext=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#poll-state').textContent).loading)
  await page.clock.fastForward(15001)
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#poll-state').textContent).errorKind==='refresh',{},{timeout:2500})
  assert.equal(JSON.parse(await page.locator('#poll-state').textContent()).data.version,6)
  version=7;await page.clock.fastForward(30001);await settled(7);checks.push('timeout retains snapshot and polling recovers')
  if(held){await held.fulfill({json:{version:999}}).catch(()=>{});held=null}
  await page.locator('#pause').click();const beforePause=calls;version=8
  await page.clock.fastForward(90000);await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))})
  assert.equal(calls,beforePause);assert.equal(JSON.parse(await page.locator('#poll-state').textContent()).data.version,7)
  await page.locator('#pause').click();await settled(8);checks.push('paused history stays frozen until resumed')
  await page.close()

  const app=await browser.newPage();app.on('pageerror',e=>errors.push(e.message));await app.clock.install()
  await app.addInitScript(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>false}))
  let includeNew=false,includeProd=false
  await app.route('**/auth/session',r=>r.fulfill({json:{user:{sub:'fixture',name:'Fixture viewer',email:'viewer@example.test',role:'viewer'},sso_enabled:true}}))
  await app.route('**/api/v1/**',r=>{
   const p=new URL(r.request().url()).pathname,prodInstance={...instance,id:'sample:prod:sample',environment:'prod',observations:{test:{...instance.observations.test,values_path:'kubernetes/prod/sample/values.yaml'}}}
   const items=[{...base,instances:[summary,...includeProd?[{...summary,environment:'prod'}]:[]]},...includeNew?[{...base,key:'new-service',project:'team/new-service',project_id:456,instances:[{...summary,id:'new-service:test:new-service',name:'new-service'}]}]:[]]
   const body=p==='/api/v1/services'?{items,environments:['test','prod'],links}:p==='/api/v1/services/sample'?{service:base,instances:[instance,...includeProd?[prodInstance]:[]],latest_attempts:[]}:{items:[]}
   return r.fulfill({json:body})
  })
  await app.goto(root+'/?env=test');await app.locator('[data-service="sample"]').waitFor();assert.equal(await app.locator('[data-service="new-service"]').count(),0)
  includeNew=true;await app.clock.fastForward(31000);await app.locator('[data-service="new-service"]').waitFor({timeout:2500});checks.push('catalog discovers a new deployed service automatically')
  await app.locator('[data-service="sample"]').click();await app.locator('.service-common').waitFor();assert.equal(await app.locator('.env-switch').getByRole('button',{name:'prod',exact:true}).count(),0)
  includeProd=true;await app.clock.fastForward(1100);await app.evaluate(()=>window.dispatchEvent(new Event('focus')));await app.locator('.env-switch').getByRole('button',{name:'prod',exact:true}).waitFor({timeout:2500});checks.push('service discovers newly deployed environment on focus')
  assert.deepEqual(errors,[]);process.stdout.write(JSON.stringify({checks,errors})+'\n')
 }finally{await browser.close()}
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1})
