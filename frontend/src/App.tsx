import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Dialog, IconButton, Snackbar, Tab, Tabs } from '@mui/material'
import { InfoTooltip, ThemeControls } from '@project/ui/mui'
import { Activity, Check, ChevronRight, Clock3, Database, FileText, Layers3, Link2, LogIn, LogOut, Network, Radio, RefreshCw, Search, Server, X } from 'lucide-react'
import { useAppRoute } from './useAppRoute'
import { CIStatus } from "./CIStatus"
import { History } from './History'
import { ServiceOverview, ServiceTechnical } from './ServiceOverview'
import {ServiceCatalogCard} from './ServiceCatalogCard'
import {ServiceHeading} from './ServiceHeading'
import { FeatureContext } from './FeatureContext'
import { ServiceIngresses } from './ServiceIngresses'
import {Sources} from './Sources'
import {useFreshnessClock} from './Freshness'
import {evaluateFreshness} from './freshness-policy'
import { archivedFeatures, isPresent, presentEnvironments, presentInstances } from './presence'
import './environment-context.css'
import { request, useEventHistory, usePoll } from './api'
import { argoCheckedAt, historicalSnapshot, latest, observationMatchesLifecycle, resourceGraph, since, type Environment, type Links, type Service, type ServiceState, type Source } from './data'
const serviceLogo = new URL('./assets/sdm-logo.png', import.meta.url).href
const ResourceGraph = lazy(() => import('./ResourceGraph').then(module => ({default: module.ResourceGraph})))
type User = {sub: string; name: string; email: string; role: 'viewer'}
type Session = {user: User | null; sso_enabled: boolean}
const emptyLinks: Links = {gitlab: null, argo: {}, deployments: null}
export default function App() {
  const now=useFreshnessClock()
  const [session, setSession] = useState<Session | null>(null), [sessionError, setSessionError] = useState('')
  const [route, navigate] = useAppRoute(), {page, service, env, tab, selected, mapOpen} = route
  const [search, setSearch] = useState(''), [toast, setToast] = useState('')
  const [copyFallback,setCopyFallback]=useState<string|null>(null)
  const expire = useCallback(() => { setSession(previous => previous ? {...previous, user: null} : null) }, [])
  const loadSession = useCallback(() => { setSessionError(''); request<Session>('/auth/session').then(setSession).catch(() => setSessionError('Не удалось проверить вход. Повторите попытку.')) }, [])
  useEffect(loadSession, [loadSession])
  const user = session?.user
  const catalog = usePoll<{items: Service[]; environments: Environment[]; links: Links}>(user ? '/api/v1/services' : null, expire)
  const sources = usePoll<{items: Source[]}>(user ? '/api/v1/sources' : null, expire)
  const detail = usePoll<ServiceState>(user && page === 'service' && service ? `/api/v1/services/${encodeURIComponent(service)}` : null, expire)
  const rows = catalog.data?.items || [], links = catalog.data?.links || emptyLinks
  const catalogEnvironments = catalog.data?.environments || []
  const registration = rows.find(item => item.key === service) || detail.data?.service
  const serviceEnvironments = presentEnvironments(detail.data?.instances || registration?.instances || [], catalogEnvironments)
  const environments = page === 'service' ? serviceEnvironments : catalogEnvironments
  useEffect(() => {
    if (page === 'catalog' && environments.length && !environments.includes(env)) navigate({env: environments[0], instance: '', selected: null}, true)
  }, [page, catalog.data, env, navigate])
  const instances = detail.data?.instances.filter(item => item.environment === env) || []
  const availableInstances = presentInstances(instances, env)
  const branchHistory=page==='service'&&tab==='history'&&!!route.historyRef
  const featureHistoryAll=env==='feature'&&tab==='history'&&!route.instance&&!branchHistory
  const instance = featureHistoryAll||branchHistory?undefined:route.instance ? instances.find(item => item.name === route.instance) : availableInstances[0]
  useEffect(() => {
    const historical = historicalSnapshot(instance)
    if (page === 'service' && tab !== 'history' && detail.hasData && !historical && serviceEnvironments.length && !serviceEnvironments.includes(env)) {
      navigate({env: serviceEnvironments[0], instance: '', selected: null}, true)
    }
  }, [page, tab, env, detail.data, serviceEnvironments, instance, navigate])
  const history = useEventHistory(user && (page === 'history' || page === 'service' && tab === 'history' && (!route.instance || instance || branchHistory)) ? page === 'history' ? '/api/v1/events' : `/api/v1/services/${encodeURIComponent(service)}/events${instance?'?instance='+encodeURIComponent(instance.id):''}` : null, expire)
  const featureArchive = archivedFeatures(detail.data?.instances || [])
  const graph = useMemo(() => registration && detail.data ? resourceGraph(registration, instance, links) : null, [registration, detail.data, instance, links])
  useEffect(() => {
    if (env === 'feature' && instance && !route.instance) navigate({instance: instance.name}, true)
  }, [env, instance, route.instance, navigate])
  const obs = latest(instance)?.[1]
  const previousApplication = !!instance&&!!obs&&!observationMatchesLifecycle(instance.lifecycle,obs.uid)
  const filtered = rows.filter(item => `${item.key} ${item.project} ${item.project_id}`.toLowerCase().includes(search.toLowerCase()) && item.instances.some(i => i.environment === env && isPresent(i)))
  const setSelected = useCallback((selected: string | null) => navigate({selected}, true), [navigate])
  const openService = (key: string, name = '') => navigate({page: 'service', service: key, instance: name, selected: null, mapOpen: false, tab: 'overview'})
  const serviceHref=(key:string)=>`/?${new URLSearchParams({page:'service',service:key,env})}`
  const showMap = (id: string | null = null) => navigate({mapOpen: true, selected: id})
  const closeMap = () => navigate({mapOpen: false, selected: null}, true)
  const copy = async (value: string,kind:'url'|'identity'='url') => { try { await navigator.clipboard.writeText(value); setToast('Скопировано') } catch { if(kind==='identity')setCopyFallback(value);else setToast('Не удалось скопировать. Скопируйте адрес из строки браузера.') } }
  const logout = async () => { try { const result = await fetch('/auth/logout', {method: 'POST', credentials: 'same-origin', headers: {'X-SDM-Request': 'logout'}}); if (!result.ok) throw new Error(); expire() } catch { setToast('Не удалось выйти. Повторите попытку.') } }
  const refresh = () => { catalog.refresh(); detail.refresh(); sources.refresh(); history.refresh() }
  const observationError=obs?.collection_error?`Сверка Application не завершена. Показан последний снимок. Код: ${obs.collection_error.code}.`:''
  const error = catalog.error || sources.error || detail.error || history.error || observationError
  const mapError=detail.error||catalog.error||sources.error||observationError
  const staleSource=(source:Source)=>evaluateFreshness({checkedAt:source.last_success_at?new Date(source.last_success_at*1000).toISOString():undefined,intervalSeconds:source.interval_seconds||undefined},now).state==='stale'
  const unhealthySources = sources.data?.items.filter(s => s.error_code || !s.last_success_at || staleSource(s)) || []
  const envSwitch = serviceEnvironments.length ? <div className="env-switch" aria-label="Окружения сервиса">{serviceEnvironments.map(item => <button key={item} aria-pressed={env === item&&!branchHistory} className={env === item&&!branchHistory ? 'active' : ''} onClick={() => navigate({env: item, instance: '', selected: null})}>{item}</button>)}</div> : null
  if (!user) return <div className="login-shell"><div className="login-theme"><ThemeControls/></div><section className="login-panel"><img src={serviceLogo} alt="" width="72" height="72"/><h1>Service Delivery Monitor</h1><p>Состояние доставки, исходники и ресурсы ваших сервисов.</p>{sessionError ? <><p role="alert">{sessionError}</p><Button onClick={loadSession}>Повторить</Button></> : !session ? <p role="status">Проверка сессии…</p> : !session.sso_enabled ? <p>SSO не настроен для этого окружения.</p> : <>{new URLSearchParams(window.location.search).has('auth_error') && <p role="alert">Вход не завершен. Повторите вход через Authentik.</p>}<Button variant="contained" startIcon={<LogIn size={18}/>} href={'/auth/login?next=' + encodeURIComponent('/' + window.location.search.replace(/([?&])auth_error=[^&]*&?/, '$1').replace(/[?&]$/, ''))}>Войти через Authentik</Button><small>После входа доступен просмотр всех сервисов.</small></>}</section></div>
  return <div className="app">
    <aside className="sidebar"><a className="brand" href="/" onClick={e => {if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault(); navigate({page: 'catalog'})}}} aria-label="Service Delivery Monitor, каталог сервисов"><img className="brand-logo" src={serviceLogo} alt="" width="42" height="42"/><span className="brand-name">Service Delivery<br/>Monitor</span></a>
      <nav aria-label="Главная навигация">{([{key: 'catalog', title: 'Services', icon: Layers3}, {key: 'history', title: 'Activity', icon: Activity}, {key: 'sources', title: 'Sources', icon: Database}] as const).map(item => <button key={item.key} aria-current={page === item.key || item.key === 'catalog' && page === 'service' ? 'page' : undefined} className={`nav-item ${page === item.key || item.key === 'catalog' && page === 'service' ? 'active' : ''}`} onClick={() => navigate({page: item.key})}><item.icon size={18}/>{item.title}{item.key === 'catalog' && <span className="nav-count">{rows.length}</span>}</button>)}</nav>
      <div className="sidebar-context" role="group" aria-label="Глобальное окружение"><p>Окружения</p>{environments.map(item => <button key={item} aria-pressed={env === item} className={`environment-item ${env === item ? 'selected' : ''}`} onClick={() => navigate({env: item, instance: '', selected: null})}><span className={`environment-dot ${item}`}/>{item}<span>{item === env && <Check size={14}/>}</span></button>)}</div>
      <div className="sidebar-bottom"><div className="collector-state"><Radio size={15}/><span>{unhealthySources.length ? 'Проверьте Sources' : 'Фоновая сверка'}</span></div><div className="user"><span className="avatar">{user.name.slice(0,2).toUpperCase()}</span><div title={user.email}>{user.name}<small>Просмотр всех сервисов</small></div><IconButton size="small" aria-label="Выйти из SDM" onClick={logout}><LogOut size={16}/></IconButton></div></div>
    </aside>
    <div className="shell"><header className="topbar"><div className="breadcrumbs"><button onClick={() => navigate({page: 'catalog'})}>Services</button>{page !== 'catalog' && <><ChevronRight size={13}/><span>{page === 'service' ? service : page === 'history' ? 'Activity' : 'Sources'}</span></>}</div><div className="topbar-right"><IconButton aria-label="Обновить данные" title="Обновить сохраненное состояние SDM" onClick={refresh}><RefreshCw size={17}/></IconButton><ThemeControls/></div></header>
      <main className={page === 'service' ? 'service-page' : undefined}>
        {error && <div className="live-notice" role="alert">{error}<Button size="small" onClick={refresh}>Повторить</Button></div>}
        {!!unhealthySources.length && <div className="live-notice"><Clock3 size={16}/><span>Часть наблюдений недоступна или устарела. Показано последнее известное состояние.</span><Button size="small" onClick={() => navigate({page: 'sources'})}>Источники</Button></div>}
        {page === 'catalog' && <><div className="page-heading compact-catalog-heading"><h1>Services</h1><span className="catalog-context">{env} · показано {filtered.length} из {rows.length}</span><label className="search-field"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Найти сервис, репозиторий или ID" aria-label="Найти сервис"/></label></div>

          <div className="service-catalog" aria-label="Каталог сервисов">{filtered.map(item=><ServiceCatalogCard key={item.key} service={item} env={env} links={links} href={serviceHref(item.key)} onOpen={()=>openService(item.key)}/>)}</div>
          {!filtered.length && !catalog.error && <div className="empty-state"><Search size={25}/><h3>{catalog.loading && !catalog.data ? 'Загрузка каталога…' : rows.length ? 'Сервисы не найдены' : 'Каталог пока пуст'}</h3><p>{rows.length ? 'Измените поиск или выберите другое окружение.' : 'После успешной сверки здесь появятся сервисы из publisher.'}</p></div>}{catalog.error&&!catalog.hasData&&<div className="empty-state"><h3>Каталог недоступен</h3><p>Данные пока не получены. Повторите загрузку.</p><Button onClick={catalog.refresh}>Повторить загрузку</Button></div>}</>}
        {page === 'service' && <><ServiceHeading name={service} registration={registration} instance={instance} observation={obs} repository={graph?.data.repo} environmentSwitch={envSwitch} mapDisabled={!graph||featureHistoryAll||branchHistory} emptyLabel={!obs&&!featureHistoryAll&&!branchHistory&&detail.hasData?'Нет наблюдений':undefined} onBack={()=>navigate({page:'catalog'})} onMap={()=>showMap()} onCopy={()=>copy(window.location.href)}/>{previousApplication&&<p className="live-notice" role="status">Показан предыдущий Application. Ожидается сверка нового UID в ArgoCD.</p>}{obs?.present===false&&<p className="live-notice" role="status">Application отсутствует в последней сверке. Показан сохраненный снимок.</p>}
          {env === 'feature' && !branchHistory && <FeatureContext instance={instance} choices={availableInstances} onChange={name => navigate({instance: name, selected: null})}/>}
          {route.instance && !instance && !branchHistory && detail.hasData && <p role="status">Указанное в ссылке окружение не найдено.</p>}
          {!instance && !route.instance && !featureHistoryAll && !branchHistory && detail.data && <p className="live-notice" role="status">В окружении {env} нет подтвержденного Application. Выберите доступное окружение выше или посмотрите историю.</p>}
          {featureHistoryAll&&<p className="history-scope-note">История всех feature-экземпляров</p>}{branchHistory&&<p className="history-scope-note">Ветка <code>{route.historyRef}</code> · все окружения <Button size="small" onClick={()=>navigate({historyRef:''})}>Снять фильтр ветки</Button></p>}
          {detail.data&&registration&&!branchHistory&&<CIStatus state={detail.data} registration={registration} instance={instance} env={env} links={links}/>} {graph&&instance&&isPresent(instance)&&<ServiceIngresses data={graph.data}/>}<div className="service-toolbar overview-toolbar"><Tabs value={tab} onChange={(_, value) => navigate({tab: value})} aria-label="Представление сервиса" selectionFollowsFocus><Tab id="service-tab-overview" value="overview" aria-controls="service-panel-overview" icon={<Server size={16}/>} iconPosition="start" label="Overview"/><Tab id="service-tab-history" value="history" aria-controls="service-panel-history" icon={<Clock3 size={16}/>} iconPosition="start" label="History"/><Tab id="service-tab-technical" value="technical" aria-controls="service-panel-technical" icon={<FileText size={16}/>} iconPosition="start" label="Технические данные"/></Tabs></div>
          <div role="tabpanel" id={`service-panel-${tab}`} aria-labelledby={`service-tab-${tab}`}>{tab === 'history' ? <History items={history.data?.items} loading={history.loading} error={history.error} services={rows} links={links} serviceKey={service} environment={branchHistory?undefined:env} instanceName={branchHistory?undefined:instance?.name||route.instance} sourceRef={instance?.source_ref} historyRef={branchHistory?route.historyRef:undefined} archived={branchHistory?[]:featureArchive} onOpenArchive={item=>navigate({env:"feature",instance:item.name,tab:"history",mapOpen:false,selected:null})} hasMore={history.hasMore} onLoadMore={history.loadMore} moreLoading={history.moreLoading} moreError={history.moreError}/> : graph ? tab === 'technical' ? <ServiceTechnical data={graph.data}/> : <ServiceOverview data={graph.data} onShowMap={showMap} environment={env}/> : detail.error&&!detail.hasData?<div className="empty-state"><h3>Данные сервиса недоступны</h3><Button onClick={detail.refresh}>Повторить загрузку</Button></div>:<div className="empty-state">Загрузка сервиса…</div>}</div>
        </>}
        {page === "sources" && <Sources items={sources.data?.items} loading={sources.loading} error={sources.error}/>}
        {page === 'history' && <><div className="page-heading"><div><h1>Activity</h1><p>События build, публикации и доставки</p></div></div><History items={history.data?.items} loading={history.loading} error={history.error} services={rows} links={links} hasMore={history.hasMore} onLoadMore={history.loadMore} moreLoading={history.moreLoading} moreError={history.moreError}/></>}
      </main>
    </div>
    <Dialog open={mapOpen && page === 'service' && !!graph} fullScreen aria-labelledby="resource-map-title" className="map-overlay" PaperProps={{className: 'map-dialog'}} onClose={(_, reason) => {if (reason === 'escapeKeyDown' && selected) setSelected(null); else closeMap()}}><header className="map-dialog-heading"><div><Network size={21}/><div><h2 id="resource-map-title">Карта сервиса · {service}</h2><span>{env}{env==='feature'&&instance&&` · ${instance.source_ref} · ${instance.name.slice(-8)}`}{obs?.namespace ? ` · Namespace ${obs.namespace}` : ""} · {obs ? <>ArgoCD: {since(argoCheckedAt(obs))}{obs.runtime?.observed_at && <> · Проверка ресурсов: {since(obs.runtime.observed_at)}</>}</> : "Регистрация"}</span></div></div>{mapError&&<div className="map-refresh-error" role="alert"><span title={mapError}>{mapError}</span><Button size="small" onClick={refresh}>Повторить</Button></div>}<div className="map-dialog-actions"><Button size="small" startIcon={<Link2 size={16}/>} onClick={() => copy(window.location.href)}>Скопировать ссылку</Button><IconButton aria-label="Закрыть карту" onClick={closeMap}><X size={21}/></IconButton></div></header><div className="map-dialog-content"><Suspense fallback={<div className="empty-state">Загрузка карты…</div>}>{graph && <ResourceGraph key={`${service}:${env}:${instance?.name || ''}`} data={graph.data} relationships={graph.relationships} selected={selected} onSelect={setSelected} onCopy={value=>copy(value,"identity")}/>}</Suspense></div></Dialog>
    <Dialog open={copyFallback!==null} onClose={()=>setCopyFallback(null)} aria-labelledby="identity-copy-title"><div className="identity-copy-fallback"><h2 id="identity-copy-title">Идентификатор ресурса</h2><p>Автоматическое копирование недоступно. Выделите значение и скопируйте его.</p><textarea autoFocus readOnly aria-label="Идентификатор ресурса" value={copyFallback||''} onFocus={event=>event.currentTarget.select()}/><Button onClick={()=>setCopyFallback(null)}>Закрыть</Button></div></Dialog>
    <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast('')} message={toast}/>
  </div>
}
