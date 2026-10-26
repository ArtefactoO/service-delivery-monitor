import test from 'node:test'
import assert from 'node:assert/strict'
import {serviceHistoryHref} from '../src/activity-context.ts'
import {scopeHistory, buildHistory} from '../src/history-data.ts'

const ci = (id, kind, ref, target) => ({id, service: 'sample', kind, received_at: 1792152000 + id,
  payload: {status: 'succeeded', occurred_at: new Date(1792152000000 + id * 1000).toISOString(),
    source: {ref, revision: 'a'.repeat(40)}, attempt: {pipeline_id: id, job_id: id}, ...(target ? {target} : {})}})

test('a targetless tagged build opens its exact ref without guessing test or a live instance', () => {
  const clicked = ci(1, 'build', 'v1.2.3')
  const operation = buildHistory([clicked]).operations[0]
  const url = new URL(serviceHistoryHref(operation.service, undefined, undefined, operation.ref), 'https://sdm.example')
  assert.equal(url.searchParams.get('history_ref'), 'v1.2.3')
  assert.equal(url.searchParams.has('env'), false)
  assert.equal(url.searchParams.has('instance'), false)
  assert.deepEqual(scopeHistory([clicked], 'test', 'sample', 'dev', url.searchParams.get('history_ref')), [clicked])
})

test('branch history includes matching publication and Argo across environments and rejects other refs', () => {
  const build = ci(1, 'build', 'release/2026.10')
  const testPublish = ci(2, 'publication', 'release/2026.10', {environment: 'test', instance: 'old-test'})
  const prodDeploy = ci(3, 'deployment', 'release/2026.10', {environment: 'prod', instance: 'old-prod'})
  const argo = {id: 4, service: 'sample', kind: 'argocd_notification', payload: {event: 'sync_succeeded', source_ref: 'release/2026.10', environment: 'prod', application: 'old-prod'}}
  const other = ci(5, 'build', 'dev')
  assert.deepEqual(scopeHistory([build, testPublish, prodDeploy, argo, other], 'test', 'current', 'dev', 'release/2026.10').map(item => item.id), [1, 2, 3, 4])
  const url = new URL(serviceHistoryHref('sample', 'test', 'current', 'release/2026.10'), 'https://sdm.example')
  assert.equal(url.searchParams.get('history_ref'), 'release/2026.10')
  assert.equal(url.searchParams.has('env'), false)
  assert.equal(url.searchParams.has('instance'), false)
})

test('branch scope is exact and does not modify historical event facts', () => {
  const events = [ci(1, 'build', 'feature/a+b & c'), ci(2, 'build', 'feature/a+b & c-2')]
  const saved = structuredClone(events)
  const url = new URL(serviceHistoryHref('sample', undefined, undefined, events[0].payload.source.ref), 'https://sdm.example')
  assert.deepEqual(scopeHistory(events, undefined, undefined, undefined, url.searchParams.get('history_ref')).map(item => item.id), [1])
  assert.deepEqual(events, saved)
})
