import {ArrowUpRight} from 'lucide-react'
import {InfoTooltip} from '@project/ui/mui'
import {safeUrl,tone,type Environment,type Instance,type Links,type Service,type ServiceState} from './data'
import {ciAttemptDetails} from './activity-context'
import {ciHeaderContext,publicationProvenance} from './ci-status-data'
import {LinkedValue} from './LinkedValue'

export function CIStatus({state,registration,instance,env,links}:{state:ServiceState;registration:Service;instance?:Instance;env:Environment;links:Links}){
 if(env==='feature'&&!instance)return null
 const context=ciHeaderContext(state,registration,instance,env),{observation,ref}=context
 const provenance=observation?publicationProvenance(registration,observation,links):[]
 const stages=[['build','Build'],['publication','Publication'],['deployment','Deploy']].map(([kind,label])=>{
  const p=kind==='build'?context.build:kind==='publication'?context.publication:context.deployment
  const scope=kind==='build'?ref:env
  if(!p)return <InfoTooltip key={kind} title={'SDM не получил событий '+label+' для '+(scope||env)+'. Состояние из ArgoCD показано отдельно.'} describeChild><span className="ci-stage-empty" tabIndex={0}>{label}: нет событий</span></InfoTooltip>
  const repo=kind==='build'?(links.gitlab?links.gitlab+'/'+registration.project:undefined):links.deployments?.replace(/\.git$/,'')
  const href=repo?safeUrl(repo.replace(/\/$/,'')+'/-/jobs/'+p.attempt.job_id):undefined
  const stageLabel=p.action==='delete'?(kind==='publication'?'Removal publication':'Stop'):label
  const value=stageLabel+' #'+p.attempt.job_id
  const comparison=kind==='build'&&context.imageComparison?(context.imageComparison==='same'?'Image этой попытки совпадает с наблюдаемой публикацией ArgoCD по всем digest.':'В этой попытке указан другой digest image, чем в наблюдаемой публикации ArgoCD.'):''
  const tooltip=ciAttemptDetails(p,observation)+(comparison?'\n'+comparison:'')+(href?'\nОткрыть job GitLab в новой вкладке.':'')
  const accessible=value+', '+p.status+', '+(scope||'')
  return <InfoTooltip key={kind} title={<span style={{whiteSpace:'pre-line'}}>{tooltip}</span>} describeChild>{href?<a className={'ci-stage sheet-value-link tone-'+tone(p.status)} aria-label={accessible} href={href} target="_blank" rel="noopener noreferrer"><span>{value}</span><ArrowUpRight size={13}/></a>:<span className={'ci-stage tone-'+tone(p.status)} tabIndex={0} aria-label={accessible}>{value}</span>}</InfoTooltip>
 })
 return <div className="ci-context" aria-label="Публикация и события CI">
  {observation&&<div className="ci-context-row ci-observed-publication"><span className="ci-context-label">{context.inactive?'Last observed version':'Deployed version'}</span><div className="ci-context-items">{provenance.map(link=><LinkedValue key={link.label} value={link.label} href={link.href} target={link.label}/>)}{!provenance.length&&<span className="muted">Идентификаторы CI не получены</span>}</div></div>}
  <div className="ci-context-row ci-attempts" aria-label="Последние попытки CI"><span className="ci-context-label">Latest CI runs</span><div className="ci-context-items">{stages}</div></div>
 </div>
}
