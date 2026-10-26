// Isolated hook fixture served by the existing Vite container; no application or SSO is impersonated.
import {useCallback, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {usePoll} from '../src/api'
import {useAppRoute} from '../src/useAppRoute'

function Probe() {
  const [url, setUrl] = useState('/probe/value'), [unauthorized, setUnauthorized] = useState(false), [paused, setPaused] = useState(false)
  const expire = useCallback(() => setUnauthorized(true), [])
  const state = usePoll<{version: number}>(url, expire, paused)
  const [route, navigate] = useAppRoute()
  return <>
    <pre id="poll-state">{JSON.stringify({data: state.data, hasData: state.hasData, loading: state.loading, error: state.error, errorKind: state.errorKind, unauthorized})}</pre>
    <button id="refresh" onClick={state.refresh}>Повторить</button>
    <button id="other-url" onClick={() => setUrl('/probe/other')}>Другой источник</button>
    <button id="pause" aria-pressed={paused} onClick={() => setPaused(value => !value)}>Пауза</button>
    <pre id="route-state">{JSON.stringify(route)}</pre>
    <button id="branch-history" onClick={() => navigate({page: 'service', service: 'sample', tab: 'history', instance: '', historyRef: 'v1.2.3'})}>История ветки</button>
    <button id="select-env" onClick={() => navigate({env: 'prod', instance: ''})}>Окружение</button>
    <button id="open-overview" onClick={() => navigate({tab: 'overview'})}>Обзор</button>
    <button id="open-technical" onClick={() => navigate({tab: 'technical'})}>Технические данные</button>
  </>
}
createRoot(document.getElementById('root')!).render(<Probe/>)
