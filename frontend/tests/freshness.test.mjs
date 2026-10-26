import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateFreshness} from '../src/freshness-policy.ts'

const checkedAt = '2026-10-16T10:00:00Z'
const checked = Date.parse(checkedAt)
const info = {checkedAt, intervalSeconds: 600}

test('freshness expires only after five successful-check intervals, independently of health changes', () => {
  assert.equal(evaluateFreshness(info, checked + 3000 * 1000).state, 'fresh')
  assert.equal(evaluateFreshness(info, checked + 3000 * 1000 + 1).state, 'stale')
  assert.equal(evaluateFreshness({...info, checkedAt: '2026-10-16T10:45:00Z'}, checked + 3001 * 1000).state, 'fresh')
  assert.equal(evaluateFreshness({checkedAt, intervalSeconds: 300}, checked + 2000 * 1000).state, 'stale')
})

test('missing or invalid successful-check evidence stays unknown', () => {
  for (const value of [undefined, {}, {intervalSeconds: 600}, {...info, checkedAt: 'invalid'},
    {checkedAt}, {...info, intervalSeconds: 0}, {...info, intervalSeconds: -1},
    {...info, intervalSeconds: NaN}, {...info, intervalSeconds: Infinity}]) {
    assert.equal(evaluateFreshness(value, checked + 90000 * 1000).state, 'unknown')
  }
  assert.equal(evaluateFreshness(info, NaN).state, 'unknown')
})

test('future observation timestamps cannot become stale through clock skew', () => {
  const result = evaluateFreshness(info, checked - 1000)
  assert.equal(result.state, 'fresh')
  assert.equal(result.ageSeconds, 0)
})

test('archived or inactive observations do not acquire a live stale warning', () => {
  assert.equal(evaluateFreshness({...info, inactive: true}, checked + 90000 * 1000).state, 'inactive')
  assert.equal(evaluateFreshness({inactive: true}, checked).state, 'inactive')
})
