import test from 'node:test'
import assert from 'node:assert/strict'
import {sourceDiagnostics, sourceErrorMessage, sourceRequestGate} from '../src/source-diagnostics.ts'

const now = 1792152000000
const current = now / 1000
const source = {name: 'test', kind: 'argocd', interval_seconds: 600, last_success_at: current - 200,
  last_attempt_at: current - 200, error_code: null, failures: 0}

test('request permission takes the greatest spacing, backoff, and full-budget deadline', () => {
  const input = {next_request_at: current + 2, backoff_until: current + 50,
    window_start: current - 100, window_seconds: 300, window_count: 30, requests_per_window: 30}
  const result = sourceRequestGate(input, now)
  assert.equal(result.allowedAt, current + 200)
  assert.equal(result.delayed, true)
  assert.deepEqual(new Set(result.reasons), new Set(['spacing', 'backoff', 'budget']))
  assert.equal(sourceRequestGate({...input, backoff_until: current + 400}, now).allowedAt, current + 400)
})

test('an expired or non-full budget cannot postpone a request', () => {
  const input = {window_start: current - 300, window_seconds: 300, window_count: 30, requests_per_window: 30}
  assert.equal(sourceRequestGate(input, now).delayed, false)
  assert.equal(sourceRequestGate({...input, window_start: current - 100, window_count: 29}, now).delayed, false)
  assert.equal(sourceRequestGate({...input, next_request_at: current}, now).delayed, false)
})

test('missing and invalid budget metadata is not invented', () => {
  for (const input of [{}, {window_count: 30}, {window_start: current, window_seconds: 300, window_count: 30},
    {window_start: current, window_seconds: 300, window_count: 30, requests_per_window: 0},
    {next_request_at: Infinity, backoff_until: NaN}, {next_request_at: Number.MAX_VALUE}, {next_request_at: -1}]) {
    assert.equal(sourceRequestGate(input, now).delayed, false)
  }
})

test('source staleness is separate from its latest request error', () => {
  const failed = sourceDiagnostics({...source, error_code: 'http_403', last_success_at: current - 3001}, now)
  assert.equal(failed.freshness.state, 'stale')
  assert.equal(failed.status.label, 'Ошибка сверки')
  assert.match(failed.error, /права SDM/)
  const noError = sourceDiagnostics({...source, last_success_at: current - 3001}, now)
  assert.equal(noError.freshness.state, 'stale')
  assert.equal(noError.error, null)
  assert.notEqual(noError.status.tone, 'ok')
  assert.equal(sourceDiagnostics({...source, last_success_at: current - 3000}, now).freshness.state, 'fresh')
})

test('an unsuccessful first attempt cannot look like a successful observation', () => {
  const waiting = sourceDiagnostics({...source, last_success_at: null}, now)
  assert.equal(waiting.freshness.state, 'unknown')
  assert.equal(waiting.status.label, 'Ожидание данных')
  assert.equal(sourceDiagnostics({...source, last_success_at: null, error_code: 'connection_failed'}, now).status.tone, 'danger')
  assert.equal(sourceDiagnostics({...source, interval_seconds: null}, now).freshness.state, 'unknown')
  assert.equal(sourceDiagnostics({...source, last_success_at: Number.MAX_VALUE}, now).freshness.state, 'unknown')
})

test('human error labels preserve uncertainty instead of guessing a network or auth cause', () => {
  assert.match(sourceErrorMessage('connection_failed'), /связаться/)
  assert.doesNotMatch(sourceErrorMessage('connection_failed'), /парол|таймаут|DNS|VPN/i)
  assert.match(sourceErrorMessage('http_429'), /частоту/)
  assert.match(sourceErrorMessage('http_503'), /ошибку сервера/)
  assert.equal(sourceErrorMessage(null), null)
  assert.match(sourceErrorMessage('unrecognized'), /Код ошибки/)
})
