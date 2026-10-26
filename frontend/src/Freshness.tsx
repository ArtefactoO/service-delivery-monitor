import {createContext, useContext, useEffect, useState, type ReactNode} from 'react'
import {ClockAlert} from 'lucide-react'
import {InfoTooltip} from '@project/ui/mui'
import {evaluateFreshness, STALE_INTERVALS, type FreshnessInfo} from './freshness-policy'
import './freshness.css'

const FreshnessClock = createContext<number | null>(null)
const exactTime = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'medium', timeStyle: 'long'})

/** One clock serves all visible resources, including portals opened by the map. */
function ClockProvider({children}: {children: ReactNode}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])
  return <FreshnessClock.Provider value={now}>{children}</FreshnessClock.Provider>
}

export function FreshnessProvider({children}: {children: ReactNode}) {
  const existingClock = useContext(FreshnessClock)
  return existingClock === null ? <ClockProvider>{children}</ClockProvider> : <>{children}</>
}

export function useFreshnessClock() {
  return useContext(FreshnessClock) ?? Date.now()
}

const duration = (seconds: number) => seconds % 3600 === 0 ? `${seconds / 3600}h`
  : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`

export function FreshnessBadge({info, className = '', compact = false, focusable = true}: {info?: FreshnessInfo; className?: string; compact?:boolean; focusable?:boolean}) {
  const freshness = evaluateFreshness(info, useFreshnessClock())
  // Unknown evidence and archived snapshots must not look like a failed live check.
  if (freshness.state !== 'stale') return null
  const tooltip = `Последняя успешная проверка: ${exactTime.format(new Date(freshness.checkedAt!))}. Данные считаются устаревшими через ${STALE_INTERVALS} интервалов автоопроса (${duration(freshness.thresholdSeconds!)}). Последнее наблюдение сохранено без изменений.`
  return <InfoTooltip title={tooltip} describeChild>
    <span className={`freshness-badge nodrag nopan ${className}`.trim()} tabIndex={focusable?0:undefined}>
      <ClockAlert size={13} aria-hidden="true"/><span>{compact?'Устарело':'Данные устарели'}</span>
    </span>
  </InfoTooltip>
}
