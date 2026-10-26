import {evaluateFreshness, type FreshnessInfo} from './freshness-policy.ts'
import type {Source, Tone} from './data'

type SourceLimits = {
  requests_per_window?: number | null
  window_seconds?: number | null
  min_request_interval_seconds?: number | null
  timeout_seconds?: number | null
  window_count?: number | null
  window_start?: number | null
  next_request_at?: number | null
  backoff_until?: number | null
}
export type DiagnosticSource = Source & SourceLimits
export type RequestGateReason = 'spacing' | 'backoff' | 'budget'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const timestamp = (value: unknown): value is number => finite(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime())

export function sourceErrorMessage(code?: string | null): string | null {
  if (!code) return null
  if (code === 'partial_application_failure') return 'SDM не смог обновить данные части Applications. Это ошибка сбора, она не означает ошибку Sync в ArgoCD. Сохранены последние наблюдения; остальные проверки продолжаются.'
  if (code === 'unresolved_values_revision') return 'ArgoCD еще не передал точную revision generated values. SDM дождется ее перед чтением метаданных.'
  if (code === 'http_401' || code === 'http_403') return 'Источник отклонил доступ. Проверьте учетные данные и права SDM.'
  if (code === 'http_404') return 'Ресурс источника не найден. Проверьте адрес и настройки интеграции.'
  if (code === 'http_429') return 'Источник ограничил частоту запросов. Сборщик выдерживает паузу перед повтором.'
  if (/^http_5\d\d$/.test(code)) return 'Источник вернул ошибку сервера. Сборщик повторит запрос после паузы.'
  if (/^http_\d{3}$/.test(code)) return 'Источник отклонил запрос. Подробности доступны ниже.'
  if (code === 'connection_failed') return 'Не удалось связаться с источником. Проверьте его доступность из SDM.'
  if (code === 'response_too_large') return 'Ответ источника превышает допустимый размер.'
  if (code === 'application_identity_mismatch') return 'Application изменился во время сверки. Данные будут проверены повторно.'
  if (code === 'gitlab_source_required') return 'Для сверки не настроен источник GitLab.'
  if (code === 'invalid_source_data' || code === 'invalid_application_list') return 'Не удалось прочитать данные источника. Проверьте совместимость интеграции.'
  return 'Ошибка фоновой сверки. Код ошибки доступен ниже.'
}

/** Earliest permitted request, not the worker's next scheduled reconciliation. */
export function sourceRequestGate(source: SourceLimits, nowMs = Date.now()) {
  const candidates: {at: number; reason: RequestGateReason}[] = []
  if (timestamp(source.next_request_at)) candidates.push({at: source.next_request_at, reason: 'spacing'})
  if (timestamp(source.backoff_until)) candidates.push({at: source.backoff_until, reason: 'backoff'})
  if (timestamp(source.window_start) && finite(source.window_seconds) && source.window_seconds > 0
    && finite(source.window_count) && finite(source.requests_per_window) && source.requests_per_window > 0
    && source.window_count >= source.requests_per_window) {
    const end = source.window_start + source.window_seconds
    if (Number.isFinite(end) && end * 1000 > nowMs) candidates.push({at: end, reason: 'budget'})
  }
  const allowedAt = candidates.length ? Math.max(...candidates.map(item => item.at)) : null
  const delayed = allowedAt !== null && Number.isFinite(nowMs) && allowedAt * 1000 > nowMs
  return {allowedAt, delayed, reasons: delayed ? candidates.filter(item => item.at * 1000 > nowMs).map(item => item.reason) : []}
}

export function sourceDiagnostics(source: DiagnosticSource, nowMs = Date.now()) {
  const info: FreshnessInfo = {
    checkedAt: timestamp(source.last_success_at) ? new Date(source.last_success_at * 1000).toISOString() : undefined,
    intervalSeconds: finite(source.interval_seconds) && source.interval_seconds > 0 ? source.interval_seconds : undefined,
  }
  const freshness = evaluateFreshness(info, nowMs)
  const error = sourceErrorMessage(source.error_code)
  const status: {label: string; tone: Tone} = error ? {label: 'Ошибка сверки', tone: 'danger'}
    : freshness.checkedAt === null ? {label: 'Ожидание данных', tone: 'muted'}
    : {label: 'Последняя сверка успешна', tone: 'muted'}
  return {info, freshness, error, status, gate: sourceRequestGate(source, nowMs)}
}
