import { Globe } from 'lucide-react'
import { LinkedValue } from './ServiceOverview'
import type { Resource } from './data'

export function ServiceIngresses({data}:{data:Record<string,Resource>}){
  const endpoints=new Map<string,{label:string;resource:string}>()
  for(const resource of Object.values(data))for(const endpoint of resource.endpoints||[])endpoints.set(endpoint.url,{label:endpoint.label,resource:resource.title})
  if(!endpoints.size){
    const ingresses=Object.values(data).filter(r=>r.kind==='Ingress')
    if(!ingresses.length)return null
    return <div className="service-endpoints" aria-label="Адреса сервиса"><span><Globe size={15}/>Адреса</span><span>{ingresses.some(r=>r.endpoints===undefined)?'Ожидают сверки Ingress':'У правил Ingress нет однозначного URL'}</span></div>
  }
  return <div className="service-endpoints" aria-label="Адреса сервиса"><span><Globe size={15}/>Адреса</span>{[...endpoints].map(([url,item])=><LinkedValue key={url} value={item.label} href={url} target={`сервис через ingress ${item.resource}`}/>)}</div>
}
