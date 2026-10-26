import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventRecord } from './data'
export class ApiError extends Error { constructor(public status: number) { super(`HTTP ${status}`) } }
export async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal})
  if (!response.ok) throw new ApiError(response.status)
  return response.json()
}
export function usePoll<T>(url: string | null, onUnauthorized: () => void, paused=false) {
  const [snapshot, setSnapshot] = useState<{url: string; value: T} | null>(null)
  const snapshotRef = useRef(snapshot)
  const [failure, setFailure] = useState<{url: string; message: string; kind: 'initial' | 'refresh'} | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null), [settledUrl, setSettledUrl] = useState<string | null>(null), [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!url) { snapshotRef.current = null; setSnapshot(null); setFailure(null); setPendingUrl(null); setSettledUrl(null); return }
    if (paused) return
    let stopped = false, unauthorized = false, inFlight = false, lastStartedAt = 0
    let controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      if (stopped || unauthorized || inFlight) return
      clearTimeout(timer); timer = undefined
      inFlight = true; lastStartedAt = Date.now()
      const active = new AbortController(); controller = active
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; active.abort() }, 15000)
      setPendingUrl(url)
      try {
        const value = await request<T>(url, active.signal)
        if (!stopped) { snapshotRef.current = {url, value}; setSnapshot(snapshotRef.current); setFailure(null) }
      } catch (e) {
        if (stopped || active.signal.aborted && !timedOut) return
        if (e instanceof ApiError && e.status === 401) { unauthorized = true; snapshotRef.current = null; setSnapshot(null); setFailure(null); onUnauthorized(); return }
        const hasData = snapshotRef.current?.url === url
        const message = e instanceof ApiError && e.status === 404
          ? /^\/api\/v1\/services\/[^/]+$/.test(url) ? 'Сервис отсутствует в актуальном каталоге.' : 'Данные по этому адресу не найдены.'
          : hasData ? 'Не удалось обновить данные. Показан последний снимок. Повторите попытку.' : 'Не удалось загрузить данные. Повторите попытку.'
        setFailure({url, message, kind: hasData ? 'refresh' : 'initial'})
      } finally {
        clearTimeout(timeout); inFlight = false
        if (!stopped) { setPendingUrl(null); setSettledUrl(url); if (!unauthorized) timer = setTimeout(poll, 30000) }
      }
    }
    const poll = () => { if (!document.hidden) void run(); else timer = setTimeout(poll, 30000) }
    const resume = () => { if (!document.hidden && Date.now() - lastStartedAt >= 1000) void run() }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    void run()
    return () => {
      stopped = true; controller?.abort(); clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
    }
  }, [url, revision, onUnauthorized, paused])
  const hasData = !!url && snapshot?.url === url
  const currentFailure = failure?.url === url ? failure : null
  return {data: hasData ? snapshot!.value : null, hasData, error: currentFailure?.message || '', errorKind: currentFailure?.kind || null,
    loading: !!url && (pendingUrl === url || !hasData && !currentFailure && settledUrl !== url), refresh}
}

/** Paging freezes the current head, so new receipts cannot leave gaps between pages. */
export function useEventHistory(url:string|null,onUnauthorized:()=>void){
  const [archive,setArchive]=useState<{url:string;items:EventRecord[];hasMore:boolean}|null>(null)
  const [moreLoading,setMoreLoading]=useState(false),[moreError,setMoreError]=useState('')
  const controller=useRef<AbortController|null>(null)
  const frozen=archive?.url===url?archive:null
  const live=usePoll<{items:EventRecord[]}>(url,onUnauthorized,!!frozen)
  useEffect(()=>{controller.current?.abort();controller.current=null;setArchive(null);setMoreError('');setMoreLoading(false);return()=>{controller.current?.abort();controller.current=null}},[url])
  const refresh=()=>{controller.current?.abort();controller.current=null;setArchive(null);setMoreError('');setMoreLoading(false);live.refresh()}
  const loadMore=async()=>{
    const items=frozen?.items||live.data?.items
    if(!url||!items?.length||controller.current)return
    const abort=new AbortController();controller.current=abort
    setArchive({url,items,hasMore:true});setMoreLoading(true);setMoreError('')
    try{
      const page=await request<{items:EventRecord[]}>(`${url}${url.includes('?')?'&':'?'}before=${Math.min(...items.map(item=>item.id))}&limit=50`,abort.signal)
      if(!abort.signal.aborted)setArchive({url,items:[...new Map([...items,...page.items].map(item=>[item.id,item])).values()],hasMore:page.items.length===50})
    }catch(error){
      if(abort.signal.aborted)return
      if(error instanceof ApiError&&error.status===401){onUnauthorized();return}
      setMoreError('Не удалось загрузить более ранние события. Попробуйте еще раз.')
    }finally{if(controller.current===abort){controller.current=null;setMoreLoading(false)}}
  }
  return{...live,data:frozen?{items:frozen.items}:live.data,loading:frozen?false:live.loading,refresh,loadMore,moreLoading,moreError,hasMore:frozen?frozen.hasMore:live.data?.items.length===50}
}
