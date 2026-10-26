import { useCallback, useEffect, useRef, useState } from 'react'
import type { Environment } from './data'
export type AppRoute = { page: 'catalog' | 'service' | 'sources' | 'history'; service: string; env: Environment; instance: string; historyRef: string; tab: 'overview' | 'history' | 'technical'; mapOpen: boolean; selected: string | null }
const keys = ['page', 'service', 'env', 'instance', 'history_ref', 'tab', 'view', 'resource', 'scenario']
function readRoute(): AppRoute {
  const p = new URLSearchParams(window.location.search), page = p.get('page'), env = p.get('env') as Environment
  return {page: page === 'service' || page === 'sources' || page === 'history' ? page : 'catalog', service: p.get('service') || '', env: /^[a-z0-9][a-z0-9-]{0,31}$/.test(env || '') ? env : 'test', instance: p.get('instance') || '', historyRef: p.get('history_ref') || '', tab: p.get('tab') === 'history' ? 'history' : p.get('tab') === 'technical' ? 'technical' : 'overview', mapOpen: p.get('view') === 'map', selected: p.get('resource')}
}
export function useAppRoute() {
  const [route, setRoute] = useState(readRoute), current = useRef(route)
  useEffect(() => { const restore = () => { current.current = readRoute(); setRoute(current.current) }; window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore) }, [])
  const navigate = useCallback((patch: Partial<AppRoute>, replace = false) => {
    const next = {...current.current, ...patch}, url = new URL(window.location.href)
    if (patch.historyRef === undefined && (patch.page !== undefined && patch.page !== current.current.page
      || patch.service !== undefined && patch.service !== current.current.service
      || patch.env !== undefined || patch.instance !== undefined || patch.tab === 'overview')) next.historyRef = ''
    if (next.page !== 'service' || next.tab !== 'history') next.historyRef = ''
    keys.forEach(key => url.searchParams.delete(key))
    if (next.page !== 'catalog') url.searchParams.set('page', next.page)
    if (next.service) url.searchParams.set('service', next.service)
    if (next.historyRef) url.searchParams.set('history_ref', next.historyRef)
    if (!next.historyRef && next.env !== 'test') url.searchParams.set('env', next.env)
    if (!next.historyRef && next.instance) url.searchParams.set('instance', next.instance)
    if (next.tab !== 'overview') url.searchParams.set('tab', next.tab)
    if (next.mapOpen) url.searchParams.set('view', 'map')
    if (next.selected) url.searchParams.set('resource', next.selected)
    if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url)
    current.current = next; setRoute(next)
  }, [])
  return [route, navigate] as const
}
