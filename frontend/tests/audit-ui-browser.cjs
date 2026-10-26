// Focused desktop regressions; the shared fixtures are synthetic HTTP metadata.
const {chromium}=require(process.env.SDM_PLAYWRIGHT_MODULE||'playwright')
const fs=require('node:fs'),assert=require('node:assert/strict')
const root=process.env.SDM_BROWSER_URL||'http://host.docker.internal:4336'
const fixtureSource=fs.readFileSync('/tests/live-browser.cjs','utf8').split(';(async()=>')[0]
const {base,instance,feature,summary,links}=new Function('require','process',fixtureSource+';return {base,instance,feature,summary,links}')(require,process)
const contrast=(a,b)=>{
 const luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>value.startsWith('color(srgb')?n:n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0)
 const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)
}
;(async()=>{
 const browser=await chromium.launch({headless:true})
 try{
  for(const theme of ['dark','light'])for(const palette of ['signal','cobalt','orange']){
   const context=await browser.newContext({viewport:{width:1366,height:768},colorScheme:theme}),page=await context.newPage(),errors=[]
   page.on('pageerror',error=>errors.push(error.message))
   await page.addInitScript(prefs=>localStorage.setItem('delivery-monitor-ui',JSON.stringify(prefs)),{mode:theme,palette})
   await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('synthetic clipboard denial')}}}))
   await page.route('**/auth/session',route=>route.fulfill({json:{user:{sub:'synthetic',name:'Fixture viewer',email:'viewer@example.test',role:'viewer'},sso_enabled:true}}))
   await page.route('**/api/v1/**',route=>{
    const path=new URL(route.request().url()).pathname
    const body=path==='/api/v1/services'?{items:[{...base,instances:[summary,{...summary,environment:'feature',name:feature.name}]}],environments:['test','feature'],links}:
     path==='/api/v1/services/sample'?{service:base,instances:[instance,feature],latest_attempts:[]}:
     path==='/api/v1/sources'?{items:[]}:{items:[]}
    return route.fulfill({json:body})
   })
   await page.goto(root+'/?page=service&service=sample&view=map&resource=k8s:sample:Pod:sample-api-hash-pod')
   const dialog=page.getByRole('dialog',{name:'Карта сервиса · sample',exact:true})
   await page.locator('.logical-details').waitFor()
   const metrics=await page.locator('.logical-node').first().evaluate(el=>({width:getComputedStyle(el).width,height:getComputedStyle(el).height}))
   assert.deepEqual(metrics,{width:'224px',height:'116px'})
   const styles=await page.locator('.logical-edge-label:not([data-edge-label-active])').evaluateAll(nodes=>nodes.map(el=>{const style=getComputedStyle(el);return {color:style.color,background:style.backgroundColor,opacity:style.opacity}}))
   assert.ok(styles.length>0)
   for(const style of styles){assert.equal(style.opacity,'1');assert.ok(contrast(style.color,style.background)>=4.5,JSON.stringify(style))}
   const colors=await page.evaluate(()=>{
    const map=document.querySelector('.logical-map'),area=document.querySelector('.logical-flow-area')
    const probe=document.createElement('span');probe.style.color='var(--graph-active-path)';map.appendChild(probe)
    const pathColor=getComputedStyle(probe).color;probe.remove()
    return {pathColor,background:getComputedStyle(area.closest('.logical-canvas')).backgroundColor,
     active:[...document.querySelectorAll('[data-edge-active] .react-flow__edge-path')].map(el=>getComputedStyle(el).stroke),
     categories:[...document.querySelectorAll('.logical-node')].map(el=>({category:el.dataset.category,text:getComputedStyle(el.querySelector('.logical-node-kind')).color,background:getComputedStyle(el).backgroundColor})),
     logo:{width:document.querySelector('.brand-logo').naturalWidth,height:document.querySelector('.brand-logo').naturalHeight}}
   })
   assert.ok(colors.active.length>0)
   assert.ok(colors.active.every(color=>color===colors.pathColor))
   assert.ok(contrast(colors.pathColor,colors.background)>=3,JSON.stringify(colors))
   for(const color of colors.categories){assert.ok(color.category);assert.ok(contrast(color.text,color.background)>=4.5,JSON.stringify(color))}
   assert.deepEqual(colors.logo,{width:144,height:144})
   await page.locator('.logical-details .resource-extra > summary').click()
   await page.getByRole('button',{name:'Копировать идентификатор',exact:true}).click()
   const fallback=page.getByRole('dialog',{name:'Идентификатор ресурса',exact:true})
   await fallback.waitFor()
   assert.equal(await fallback.getByRole('textbox',{name:'Идентификатор ресурса',exact:true}).inputValue(),'pod')
   assert.equal(await page.getByText('Не удалось скопировать. Скопируйте адрес из строки браузера.',{exact:true}).count(),0)
   await fallback.getByRole('button',{name:'Закрыть',exact:true}).click()
   await fallback.waitFor({state:'hidden'})
   await dialog.waitFor()
   await page.getByRole('button',{name:'Закрыть карту',exact:true}).click()
   assert.match(await page.locator('nav [aria-current="page"]').innerText(),/Services/)
   await page.goto(root+'/?page=service&service=sample&env=feature&instance=feature-one')
   await page.locator('.feature-branch-chip').waitFor()
   await page.locator('.feature-branch-chip').focus()
   await page.keyboard.press('Tab')
   assert.equal(await page.locator('.feature-context .feature-age').evaluate(el=>el===document.activeElement),true)
   await page.getByRole('tooltip').getByText(/Время с момента создания feature Application/).waitFor()
   await page.getByRole('button',{name:'Sources',exact:true}).click()
   assert.equal(await page.locator('nav [aria-current="page"]').innerText(),'Sources')
   const before=page.url()
   const [popup]=await Promise.all([context.waitForEvent('page'),page.locator('.brand').click({modifiers:['Control']})])
   await popup.waitForURL(url=>url.pathname==='/'&&!url.search)
   assert.equal(page.url(),before)
   await popup.close()
   await page.goto(root+'/?page=service&service=sample&view=map&resource=sourceValues')
   await page.locator('.logical-details').waitFor()
   await page.evaluate(()=>document.fonts.ready)
   const canvas=await page.locator('.logical-flow-area').boundingBox()
   await page.mouse.move(canvas.x+8,canvas.y+8)
   await page.mouse.down()
   await page.mouse.move(canvas.x+8,canvas.y+158,{steps:4})
   await page.mouse.up()
   await page.waitForTimeout(180) // Capture the settled inspector, not its 150ms entrance.
   await page.screenshot({path:`${process.env.SDM_BROWSER_ARTIFACTS||'/artifacts'}/laptop-shared-${theme}-${palette}.png`})
   assert.deepEqual(errors,[])
   console.log(JSON.stringify({theme,palette,passed:true,metrics,minimumCaptionContrast:Math.min(...styles.map(style=>contrast(style.color,style.background))),pathContrast:contrast(colors.pathColor,colors.background),minimumCategoryContrast:Math.min(...colors.categories.map(color=>contrast(color.text,color.background))),checks:['compact cards','readable captions','one selected path color','node categories','optimized logo','current navigation','identity clipboard fallback','keyboard Uptime','modified brand link']}))
   await context.close()
  }
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
