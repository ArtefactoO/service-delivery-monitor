/** Freshness describes a successful observation, independently of resource health. */
export interface FreshnessInfo {
  checkedAt?: string
  intervalSeconds?: number
  inactive?: boolean
}

export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'inactive'
export const STALE_INTERVALS = 5

export function evaluateFreshness(info: FreshnessInfo | undefined, now = Date.now()): {
  state: FreshnessState
  checkedAt: number | null
  ageSeconds: number | null
  thresholdSeconds: number | null
} {
  const parsed = info?.checkedAt ? Date.parse(info.checkedAt) : NaN
  const checkedAt = Number.isFinite(parsed) ? parsed : null
  const interval = info?.intervalSeconds
  const thresholdSeconds = typeof interval === 'number' && Number.isFinite(interval) && interval > 0
    && Number.isFinite(interval * STALE_INTERVALS) ? interval * STALE_INTERVALS : null
  const ageSeconds = checkedAt !== null && Number.isFinite(now) ? Math.max(0, (now - checkedAt) / 1000) : null
  const state: FreshnessState = info?.inactive ? 'inactive'
    : ageSeconds === null || thresholdSeconds === null ? 'unknown'
    : ageSeconds > thresholdSeconds ? 'stale' : 'fresh'
  return {state, checkedAt, ageSeconds, thresholdSeconds}
}
