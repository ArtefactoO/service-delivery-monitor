import {Fragment,useState,type ReactNode} from 'react'
import {ChevronDown,ChevronRight,GitCommitHorizontal,Network,Workflow} from 'lucide-react'
import {IconButton} from '@mui/material'
import {InfoTooltip} from '@project/ui/mui'
import {SystemIcon} from './SystemBadge'
import {buildComponents,type ServiceComponent} from './components'
import {LinkedValue,UnknownVersion} from './LinkedValue'
import {ResourceFieldGroups} from './ResourceFields'
import {displayStatus,fieldValue,resourceCard,resourceProblem} from './resource-presentation'
import {componentReadiness,workloadCount} from './component-readiness'
import {FreshnessBadge} from './Freshness'
import {short,type Environment,type Resource} from './data'
import './service-overview.css'

export {LinkedValue} from './LinkedValue'

function MapAction({resource,onShowMap}:{resource:Resource;onShowMap:(id:string)=>void}){
 return <InfoTooltip title={'Показать '+resource.kind+' на карте'}><IconButton size="small" aria-label={'Показать на карте: '+resource.title} onClick={()=>onShowMap(resource.id)}><Network size={15}/></IconButton></InfoTooltip>
}
function FieldValue({resource,name,compact=false}:{resource:Resource;name:string;compact?:boolean}){
 const value=fieldValue(resource,name)
 return <LinkedValue value={value?compact?short(value):value:'Нет данных'} href={resource.fieldLinks?.[name]} target={name+(value?': '+value:'')}/>
}
function VersionedName({resource,field}:{resource:Resource;field:string}){
 const version=fieldValue(resource,field),versionLink=version&&resource.fieldLinks?.[field]
 return <><LinkedValue value={resource.title} href={versionLink?undefined:resource.url} target={resource.linkLabel}/>{version&&<span className="version-secondary"><FieldValue resource={resource} name={field}/></span>}</>
}
function ResourceEntry({resource,onShowMap}:{resource:Resource;onShowMap:(id:string)=>void}){
 const caption=resource.role==='configmap'?fieldValue(resource,'Files'):resource.role==='vault'?undefined:resourceCard(resource,[],fieldValue(resource,'Namespace')).caption
 const status=displayStatus(resource),problem=resourceProblem(resource)
 return <div className="component-resource compact" data-overview-resource={resource.id}>
  <span className="component-resource-kind"><SystemIcon system={resource.system}/>{resource.kind}</span>
  <div className="component-resource-value"><div className="resource-name-actions"><LinkedValue value={resource.title} href={resource.url} target={resource.linkLabel}/><MapAction resource={resource} onShowMap={onShowMap}/></div>
   {caption&&<small>{caption}</small>}
   {status&&<span className={'component-resource-state tone-'+status.tone}>{status.label}{problem?.reasons.length?' · '+problem.reasons.join(' · '):''}</span>}
   <FreshnessBadge info={resource.freshness}/>
  </div>
 </div>
}
function VersionRow({label,icon,resource,children,onShowMap}:{label:string;icon:ReactNode;resource?:Resource;children:ReactNode;onShowMap:(id:string)=>void}){
 return <div className="service-version-row" data-version-field={label}><span className="service-version-icon">{icon}</span><span className="service-version-label">{label}</span><div className="service-version-value">{children}{resource&&<MapAction resource={resource} onShowMap={onShowMap}/>}<FreshnessBadge compact info={resource?.freshness}/></div></div>
}
function CommonVersions({data,environment,onShowMap}:{data:Record<string,Resource>;environment:Environment;onShowMap:(id:string)=>void}){
 const {repo,argo,chart,config,sourceValues,values}=data
 const shared=Object.values(data).filter(resource=>(resource.componentIds?.length||0)>1&&!['repo','argo','chart','config','sourceValues','values'].includes(resource.role))
 return <section className="service-common" aria-label="Общие ресурсы сервиса"><div className="service-section-heading"><h2>Версии и исходники</h2></div>
  <div className="service-version-grid">
   {repo&&<VersionRow label="Source code" icon={<SystemIcon system="gitlab" size={17}/>} resource={repo} onShowMap={onShowMap}><VersionedName resource={repo} field="Branch"/></VersionRow>}
   {argo&&<VersionRow label="ArgoCD" icon={<SystemIcon system="argocd" size={17}/>} resource={argo} onShowMap={onShowMap}><LinkedValue value={argo.title} href={argo.url} target={argo.linkLabel}/><span className="version-secondary">values: {fieldValue(argo,'Values branch')||'Нет данных'}</span></VersionRow>}
   {chart&&<VersionRow label="Helm chart" icon={<SystemIcon system="helm" size={17}/>} resource={chart} onShowMap={onShowMap}><VersionedName resource={chart} field="Chart ref"/></VersionRow>}
   <VersionRow label="CI/CD" icon={<Workflow size={16}/>} onShowMap={onShowMap}>{repo&&fieldValue(repo,'CI/CD ref')?<FieldValue resource={repo} name="CI/CD ref"/>:<UnknownVersion label="Версия CI/CD" reason={repo&&fieldValue(repo,'CI/CD discovery')}/>}</VersionRow>
   <VersionRow label="App config" icon={<SystemIcon system="gitlab" size={17}/>} resource={config} onShowMap={onShowMap}>{config?<VersionedName resource={config} field="Branch"/>:<span className="muted">{values?fieldValue(values,'Config discovery')||'Импорт не подтвержден':'Нет данных'}</span>}</VersionRow>
   {repo&&<VersionRow label="Build" icon={<GitCommitHorizontal size={16}/>} onShowMap={onShowMap}><code><FieldValue resource={repo} name="Build revision" compact/></code></VersionRow>}
   {sourceValues&&<VersionRow label="Source values" icon={<SystemIcon system="gitlab" size={17}/>} resource={sourceValues} onShowMap={onShowMap}><span className="source-values-files">{fieldValue(sourceValues,'Common path')&&<span><small>Common</small><FieldValue resource={sourceValues} name="Common path"/></span>}{fieldValue(sourceValues,'Environment path')&&<span><small>{environment}</small><FieldValue resource={sourceValues} name="Environment path"/></span>}</span></VersionRow>}
   {values&&<VersionRow label="Generated values" icon={<SystemIcon system="gitlab" size={17}/>} resource={values} onShowMap={onShowMap}><LinkedValue value={values.title} href={values.fieldLinks?.Path} target="применяемый generated values"/>{fieldValue(values,'Branch')&&<span className="version-secondary">{fieldValue(values,'Branch')}</span>}</VersionRow>}
  </div>
  {!!shared.length&&<div className="service-common-dependencies"><h3>Общие зависимости</h3>{shared.map(resource=><div key={resource.id}><ResourceEntry resource={resource} onShowMap={onShowMap}/></div>)}</div>}
 </section>
}
function ComponentRows({component,onShowMap}:{component:ServiceComponent;onShowMap:(id:string)=>void}){
 const [expanded,setExpanded]=useState(false),readiness=componentReadiness(component.workloads)
 const main=component.workloads[0],status=displayStatus(main),restarts=workloadCount(component.workloads,'Pod restarts')
 const images=component.resources.filter(resource=>resource.role==='image'),uniqueImages=[...new Map(images.map(resource=>[resource.identity,resource])).values()]
 const problems=component.resources.filter(resource=>resource!==main&&resourceProblem(resource))
 const id='component-details-'+encodeURIComponent(component.id)
 return <Fragment>
  <tr data-component={component.id}>
   <td><button className="component-row-toggle" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<strong>{component.key}</strong>{component.workloads.length>1&&<small>{component.workloads.length} workloads</small>}</button>
    {!!problems.length&&<div className="component-table-problems" aria-label="Проблемы ресурсов">{problems.map(resource=>{const problem=resourceProblem(resource)!;return <InfoTooltip key={resource.id} title={[resource.kind,resource.title,problem.status.label,...problem.reasons].join(' · ')} describeChild><span data-overview-resource={resource.id} className={'tone-'+problem.status.tone}>{resource.kind}: {problem.status.label}{problem.reasons.length?' · '+problem.reasons.join(', '):''}</span></InfoTooltip>})}</div>}
   </td>
   <td><LinkedValue value={main.kind} href={main.url} target={main.kind+' '+main.title}/>{status&&<span className={'component-row-status tone-'+status.tone}>{status.label}</span>}<FreshnessBadge compact info={main.freshness}/></td>
   <td className={'component-readiness tone-'+readiness.tone}><InfoTooltip title={readiness.detail} describeChild><span>{readiness.label}</span></InfoTooltip></td>
   <td className="component-restarts">{main.status?.label==='Last snapshot'?'Последний снимок':restarts===undefined?'Не подтверждено':restarts}</td>
   <td>{uniqueImages.length===1?<code><LinkedValue value={short(fieldValue(uniqueImages[0],'Digest'))} href={uniqueImages[0].url} target={uniqueImages[0].linkLabel}/></code>:uniqueImages.length?<button className="component-images-toggle" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded} aria-controls={id}>{uniqueImages.length} images</button>:<span className="muted">Не сопоставлен</span>}</td>
  </tr>
  <tr id={id} className="component-expanded" hidden={!expanded}><td colSpan={5}><div className="component-expanded-resources">{component.resources.map(resource=><ResourceEntry resource={resource} onShowMap={onShowMap} key={resource.id}/>)}</div></td></tr>
 </Fragment>
}
export function ServiceOverview({data,onShowMap,environment='test'}:{data:Record<string,Resource>;onShowMap:(id:string)=>void;environment?:Environment}){
 const {components,unassigned}=buildComponents(data)
 return <section className="developer-overview component-overview" aria-label="Обзор сервиса">
  <CommonVersions data={data} environment={environment} onShowMap={onShowMap}/>
  {!!components.length&&<section className="compact-components"><div className="service-components-heading"><h2>Компоненты</h2></div><div className="component-table-scroll"><table className="component-table"><thead><tr><th>Component</th><th>Workload</th><th>Replicas</th><th>Restarts</th><th>Image</th></tr></thead><tbody>{components.map(component=><ComponentRows component={component} onShowMap={onShowMap} key={component.id}/>)}</tbody></table></div></section>}
  {!!unassigned.length&&<section className="service-unassigned" aria-label="Ресурсы без подтвержденной группы"><h2>Ресурсы без подтвержденной группы</h2><p className="developer-note">Для этих ресурсов пока нет подтвержденной связи с компонентом.</p><div className="service-unassigned-list">{unassigned.map(resource=><ResourceEntry resource={resource} onShowMap={onShowMap} key={resource.id}/>)}</div></section>}
  {!components.length&&!unassigned.length&&<p className="developer-note service-overview-empty">Компоненты появятся после публикации и обнаружения ресурсов Argo.</p>}
 </section>
}
export function ServiceTechnical({data}:{data:Record<string,Resource>}){
 return <section className="service-technical" aria-label="Технические данные сервиса"><h2>Технические данные</h2><ResourceFieldGroups resources={Object.values(data)} mode="technical" collapsible/></section>
}
