// Capture synthetic API fixtures in the real frontend. No live login or target operations.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.DEMO_URL || 'http://127.0.0.1:4187';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Use a loopback preview');
const output = process.env.DEMO_OUTPUT;
if (!output) throw Error('Set DEMO_OUTPUT');
fs.mkdirSync(output, {recursive:true});
async function run(setup, story) {
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args:['--no-sandbox']});
 try {
  const context = await browser.newContext({viewport:{width:1360,height:860},colorScheme:'dark',reducedMotion:'reduce'});
  await context.route('**/*', r => r.request().url().startsWith(base + '/') ? r.continue() : r.abort());
  await setup(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let n = 0;
  const frame = async () => {await page.waitForTimeout(650); await page.screenshot({path:path.join(output, String(n++).padStart(2,'0')+'.png')});};
  await story(page, frame);
  fs.writeFileSync(path.join(output,'capture.json'), JSON.stringify({frames:n,errors},null,2));
  if(errors.length) throw Error(errors.join('\n'));
 } finally { await browser.close(); }
}
process.env.SDM_PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
const fixtureSource=fs.readFileSync(path.join(__dirname,'../frontend/tests/live-browser.cjs'),'utf8').split(';(async()=>')[0];
const {base:service,instance,feature,summary,links}=new Function('require','process',fixtureSource+';return {base,instance,feature,summary,links}')(require,process);
run(async context=>{
 await context.route('**/auth/session',r=>r.fulfill({json:{user:{sub:'demo',name:'Demo Viewer',email:'demo@example.test',role:'viewer'},sso_enabled:true}}));
 await context.route('**/api/v1/**',r=>{
  const p=new URL(r.request().url()).pathname;
  const data=p==='/api/v1/services'?{items:[{...service,instances:[summary]}],environments:['test'],links}:
   p==='/api/v1/services/sample'?{service,instances:[instance,feature],latest_attempts:[]}:
   p==='/api/v1/sources'?{items:[]}:{items:[]};
  return r.fulfill({json:data});
 });
},async(page,frame)=>{
 await page.goto(base+'/?page=service&service=sample');await page.getByText('sample',{exact:true}).first().waitFor();await frame();
 await page.goto(base+'/?page=service&service=sample&view=map');await page.locator('.logical-node').first().waitFor();await frame();
 const picker=page.getByRole('combobox',{name:'Выбрать ресурс',exact:true});await picker.fill('sample-api-hash-pod');
 await page.getByRole('option',{name:'sample-api-hash-pod Pod',exact:true}).click();await frame();
 await page.getByRole('button',{name:'К выбранному ресурсу',exact:true}).click();await frame();
 await page.goto(base+'/?page=service&service=sample');await frame();
}).catch(e=>{console.error(e);process.exitCode=1;});
