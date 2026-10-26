import {InfoTooltip} from '@project/ui/mui'
import {ArrowUpRight} from 'lucide-react'
import {SystemIcon} from './SystemBadge'
import {FreshnessBadge,useFreshnessClock} from './Freshness'
import {evaluateFreshness} from './freshness-policy'
import {ObservationTime} from './ObservationTime'
import {LinkedValue,UnknownVersion} from './LinkedValue'
import {presentInstances,aggregateHealth} from './presence'
import {argoTone,chartVersionUrl,gitLink,safeUrl,type Environment,type Links,type Service,type InstanceSummary} from './data'
import type {MouseEvent} from 'react'

function oneValue(targets:InstanceSummary[],value:(target:InstanceSummary)=>string|undefined){
 if(!targets.length)return 'Нет данных'
 const values=[...new Set(targets.map(value))]
 return values.length===1?values[0]||'Нет данных':values.every(Boolean)?`${values.length} versions`:'Нет данных'
}
export function ServiceCatalogCard({service,env,links,href,onOpen}:{service:Service;env:Environment;links:Links;href:string;onOpen:()=>void}){
 const now=useFreshnessClock()
 const targets=presentInstances(service.instances,env),current=targets.length===1?targets[0]:undefined,overall=aggregateHealth(targets)
 const repo=links.gitlab?safeUrl(`${links.gitlab.replace(/\/$/,'')}/${service.project}`):undefined
 const ci=current?.ci,ciUrl=ci&&links.gitlab?gitLink(safeUrl(`${links.gitlab}/${ci.project}`),ci.ref):undefined
 const charts=targets.map(target=>chartVersionUrl(target.chart_repo,target.chart_ref))
 const chartUrl=charts[0]&&charts.every(url=>url===charts[0])?charts[0]:undefined
 const release=env==='prod'?current?.release:undefined
 const releaseUrl=release&&repo?safeUrl(`${repo.replace(/\/$/,'')}/-/tags/${encodeURIComponent(release.tag)}`):undefined
 const sync=oneValue(targets,target=>target.sync),health=oneValue(targets,target=>target.health)
 const label=current?[current.sync||'Unknown',current.health||'Unknown'].join(' · '):targets.every(target=>target.sync==='Synced'&&target.health==='Healthy')?'Synced · Healthy':overall.label
 const checkedAt=targets.map(target=>target.runtime?.observed_at).filter((value):value is string=>!!value).sort().at(-1)
 const freshness=(target:InstanceSummary)=>({checkedAt:target.runtime?.observed_at,intervalSeconds:target.check_interval_seconds||(target.source?links.argo_check_intervals?.[target.source]:undefined)})
 const stale=targets.find(target=>evaluateFreshness(freshness(target),now).state==='stale')
 const branch=current?.source_ref||(targets.length>1?`${new Set(targets.map(target=>target.source_ref)).size} branches`:'Нет данных')
 const activate=(event:MouseEvent<HTMLAnchorElement>)=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onOpen()}}
 return <article className="service-catalog-card" data-service={service.key}>
  <div className="catalog-card-type">{repo?<InfoTooltip title="Открыть репозиторий в GitLab" placement="top" describeChild><a className="catalog-repository sheet-value-link" href={repo} target="_blank" rel="noopener noreferrer"><SystemIcon system="gitlab" size={17}/><span>GitLab · #{service.project_id}</span><ArrowUpRight size={13}/></a></InfoTooltip>:<span><SystemIcon system="gitlab" size={17}/>GitLab · #{service.project_id}</span>}<ObservationTime at={checkedAt} partial={targets.some(target=>target.runtime?.truncated)}/></div>
  <div className="catalog-title-row"><h2><InfoTooltip title={service.key} placement="top" describeChild><a className="catalog-service-link" href={href} onClick={activate}><span>{service.key}</span></a></InfoTooltip></h2>{release&&<span className="catalog-release-tag"><LinkedValue value={'Release '+release.tag} href={releaseUrl} target={`Релиз ${release.tag}`}/></span>}<span className="catalog-environment-name">{env}</span></div>
  <div className="catalog-card-status"><span className={`status tone-${current?argoTone(current.sync,current.health):overall.tone}`} aria-label={`ArgoCD: ${current?label:`${sync} / ${health}. ${label}`}`}><span className="status-dot"/>{label}</span><FreshnessBadge compact focusable={false} info={stale?freshness(stale):undefined}/></div>
  <dl className="catalog-compact-facts"><div><dt>Branch</dt><dd><InfoTooltip title={current?`Ветка исходников: ${branch}`:`Активных feature: ${targets.length}. Ветки доступны внутри сервиса.`} describeChild><code>{branch}</code></InfoTooltip></dd></div><div><dt>Chart</dt><dd><code><LinkedValue value={oneValue(targets,target=>target.chart_ref)} href={chartUrl} target="версию Helm chart"/></code></dd></div><div><dt>CI/CD</dt><dd>{ci?<LinkedValue value={ci.ref} href={ciUrl} target={`CI/CD ${ci.ref}`}/>:targets.some(target=>target.ci)?oneValue(targets,target=>target.ci?.ref):<UnknownVersion label="Версия CI/CD" reason={current?.version_errors?.ci}/>}</dd></div></dl>
 </article>
}
