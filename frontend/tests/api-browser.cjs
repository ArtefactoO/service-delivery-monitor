// Real React hooks against synthetic HTTP responses, in the cached Vite/Playwright containers.
const {chromium} = require(process.env.SDM_PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
const root = process.env.SDM_BROWSER_URL || 'http://host.docker.internal:4329'
;(async () => {
  const browser = await chromium.launch({headless: true})
  try {
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    let status = 503, version = 1
    await page.route('**/probe/*', route => route.fulfill({status, json: status === 200 ? {version} : {error: 'fixture_failure'}}))
    const state = () => page.locator('#poll-state').textContent().then(JSON.parse)
    const settled = async predicate => {
      await page.locator('#poll-state').waitFor()
      await page.waitForFunction(predicate => {const value = JSON.parse(document.querySelector('#poll-state').textContent); return !value.loading && new Function('state', `return (${predicate})(state)`)(value)}, predicate.toString())
      return state()
    }
    await page.goto(root + '/tests/api-probe.html')
    let result = await settled(state => state.errorKind === 'initial')
    assert.equal(result.hasData, false)
    assert.equal(result.data, null)
    assert.doesNotMatch(result.error, /последний снимок/)
    status = 200
    await page.locator('#refresh').click()
    result = await settled(state => state.hasData)
    assert.deepEqual(result.data, {version: 1})
    assert.equal(result.error, '')
    assert.equal(result.errorKind, null)
    status = 503
    await page.locator('#refresh').click()
    result = await settled(state => state.errorKind === 'refresh')
    assert.equal(result.hasData, true)
    assert.deepEqual(result.data, {version: 1})
    assert.match(result.error, /последний снимок/)
    status = 200; version = 2
    await page.locator('#refresh').click()
    result = await settled(state => state.data?.version === 2)
    assert.equal(result.error, '')
    status = 503
    await page.locator('#other-url').click()
    result = await settled(state => state.errorKind === 'initial')
    assert.equal(result.hasData, false)
    assert.equal(result.data, null)
    status = 200
    await page.locator('#refresh').click()
    await settled(state => state.hasData)
    status = 401
    await page.locator('#refresh').click()
    result = await settled(state => state.unauthorized)
    assert.equal(result.hasData, false)
    assert.equal(result.data, null)
    assert.equal(result.error, '')
    assert.equal(result.errorKind, null)
    await page.locator('#branch-history').click()
    assert.equal(new URL(page.url()).searchParams.get('history_ref'), 'v1.2.3')
    assert.equal(new URL(page.url()).searchParams.has('env'), false)
    await page.reload()
    await page.locator('#route-state').waitFor()
    await page.waitForFunction(() => JSON.parse(document.querySelector('#route-state').textContent).historyRef === 'v1.2.3')
    await page.locator('#select-env').click()
    assert.equal(new URL(page.url()).searchParams.has('history_ref'), false)
    assert.equal(new URL(page.url()).searchParams.get('env'), 'prod')
    await page.locator('#branch-history').click()
    await page.locator('#open-overview').click()
    assert.equal(new URL(page.url()).searchParams.has('history_ref'), false)
    await page.locator('#branch-history').click()
    await page.locator('#open-technical').click()
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'technical')
    assert.equal(new URL(page.url()).searchParams.has('history_ref'), false)
    await page.reload()
    await page.waitForFunction(() => JSON.parse(document.querySelector('#route-state').textContent).tab === 'technical')
    assert.deepEqual(errors, [])
    process.stdout.write(JSON.stringify({first503: 'initial', refresh503: 'snapshot retained', retry: 'recovered', routeChange: 'no previous snapshot leak', unauthorized401: 'cleared and gated', historyRef: 'preserved on reload; cleared on environment/overview change'}) + '\n')
  } finally {await browser.close()}
})().catch(error => {process.stderr.write(error.stack + '\n'); process.exitCode = 1})
