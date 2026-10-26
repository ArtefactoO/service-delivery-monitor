import {ChevronDown, Database} from 'lucide-react'
import {SystemIcon} from './SystemBadge'
import {FreshnessBadge, useFreshnessClock} from './Freshness'
import {age, type Source} from './data'
import {sourceDiagnostics, type DiagnosticSource} from './source-diagnostics'
import './sources.css'

const exactTime = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'medium'})
const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const seconds = (value?: number | null) => known(value) ? `${value}s` : 'Неизвестно'
function SourceTime({value}: {value?: number | null}) {
  if (!known(value) || value <= 0) return <span>Нет данных</span>
  const date = new Date(value * 1000)
  if (!Number.isFinite(date.getTime())) return <span>Нет данных</span>
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{exactTime.format(date)}</time>
}

function SourceDetails({source}: {source: DiagnosticSource}) {
  const limits = known(source.requests_per_window) && known(source.window_seconds)
  const fields: [string, React.ReactNode][] = [
    ['Последняя попытка', <SourceTime value={source.last_attempt_at}/>],
    ['Ошибок подряд', known(source.failures) ? source.failures : 'Неизвестно'],
    ['Код ошибки', source.error_code || 'Нет'],
    ['Запросы к API', known(source.window_count) ? <>{source.window_count}{known(source.requests_per_window) ? ` / ${source.requests_per_window}` : ''}</> : 'Неизвестно'],
    ['Лимит на источник', limits ? `${source.requests_per_window} запросов / ${age(source.window_seconds)}` : 'Неизвестно'],
    ['Начало периода учета', <SourceTime value={source.window_start}/>],
    ['Пауза между запросами', seconds(source.min_request_interval_seconds)],
    ['HTTP timeout', seconds(source.timeout_seconds)],
    ['Ограничение интервала до', <SourceTime value={source.next_request_at}/>],
    ['Backoff до', <SourceTime value={source.backoff_until}/>],
  ]
  if (source.kind === 'argocd') fields.push(
    ['Applications', known(source.tracked_applications) ? source.tracked_applications : 'Неизвестно'],
    ['Проверок в очереди', known(source.pending_applications) ? source.pending_applications : 'Неизвестно'],
    ['Самая ранняя проверка в очереди', <SourceTime value={source.oldest_pending_at}/>],
    ['Плановый период ресурсов', known(source.resource_interval_seconds) ? age(source.resource_interval_seconds) : 'Неизвестно'],
  )
  if(source.last_application_error)fields.push(['Последний сбой Application',<>{source.last_application_error.application} · {source.last_application_error.code} · <SourceTime value={source.last_application_error.checked_at}/></>])
  return <details className="source-diagnostics-extra"><summary><ChevronDown size={14} aria-hidden="true"/>Дополнительно</summary><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="source-diagnostics-budget">Лимит общий для всех сервисов и feature-окружений этого источника. После исчерпания сверка продолжится в следующем периоде. Счетчик обновляется при запросах SDM.</p></details>
}

export function Sources({items, loading, error}: {items?: Source[]; loading?: boolean; error?: string}) {
  const now = useFreshnessClock()
  return <>
    <div className="page-heading"><div><h1>Sources</h1><p>Свежесть наблюдений отдельно от состояния сервисов</p></div></div>
    <div className="source-diagnostics-list">{items?.map(source => {
      const diagnostic = sourceDiagnostics(source, now)
      const behind = source.kind === 'argocd' && (known(source.resource_interval_seconds) && source.resource_interval_seconds > 900
        || known(source.pending_applications) && source.pending_applications > 0 && known(source.oldest_pending_at) && source.oldest_pending_at > 0 && now / 1000 - source.oldest_pending_at > 900)
      return <section className="source-diagnostics" key={source.name} aria-label={`Источник ${source.name}`}>
        <header className="source-diagnostics-heading">
          {source.kind === 'argocd' || source.kind === 'gitlab' ? <SystemIcon system={source.kind} size={22}/> : <Database size={22} aria-hidden="true"/>}
          <h2>{source.name}</h2><span className="source-diagnostics-kind">{source.kind === 'argocd' ? 'Argo CD' : source.kind === 'gitlab' ? 'GitLab' : 'Инициализация'}</span>
          <span className={`status tone-${diagnostic.status.tone}`}><span className="status-dot"/>{diagnostic.status.label}</span><FreshnessBadge info={diagnostic.info}/>
        </header>
        <div className="source-diagnostics-summary"><span>{source.kind === 'argocd' ? 'Список Applications проверен' : 'Успешная сверка'}: <SourceTime value={source.last_success_at}/></span><span>{source.kind === 'argocd' ? 'Период списка' : 'Пауза после сверки'}: {source.interval_seconds == null ? 'Неизвестно' : age(source.interval_seconds)}</span>{source.kind==='argocd'&&known(source.pending_applications)&&source.pending_applications>0&&<span>В очереди: {source.pending_applications}</span>}</div>
        {behind&&<p className="source-diagnostics-gate" role="status">Очередь проверок выходит за целевые 15m. Нагрузка на источник ограничена; отдельные наблюдения могут обновляться дольше.</p>}
        {diagnostic.error && <p className="source-diagnostics-error">{diagnostic.error}</p>}
        {!!source.application_errors?.length&&<ul className="source-diagnostics-error">{source.application_errors.map(item=><li key={item.application}><strong>{item.application}</strong>: {item.code}. {sourceDiagnostics({...source,error_code:item.code},now).error}</li>)}</ul>}
        {diagnostic.gate.delayed && <p className="source-diagnostics-gate">Запрос разрешен не раньше <SourceTime value={diagnostic.gate.allowedAt}/>. Это ограничение частоты, а не время следующей сверки.</p>}
        <SourceDetails source={source}/>
      </section>
    })}</div>
    {items?.length === 0 && <div className="empty-state">Источники пока не зарегистрированы. Данные появятся после запуска фоновой сверки.</div>}
    {!items && <div className="empty-state" role="status">{error?'Не удалось загрузить источники. Повторите попытку.':loading!==false?'Загрузка источников…':'Данных об источниках пока нет.'}</div>}
    <p className="source-note">Интерфейс читает сохраненное состояние SDM. Обновление страницы не запускает запросы в GitLab или Argo.</p>
  </>
}
