import type {ReactNode} from 'react'
import {ArrowLeft,Link2,Network} from 'lucide-react'
import {Button,IconButton} from '@mui/material'
import {InfoTooltip} from '@project/ui/mui'
import {SystemIcon} from './SystemBadge'
import {ObservationTime} from './ObservationTime'
import {FreshnessBadge} from './Freshness'
import {LinkedValue} from './LinkedValue'
import {fieldValue} from './resource-presentation'
import {argoCheckedAt,argoTone,historicalSnapshot,type Instance,type Observation,type Resource,type Service} from './data'

export function ServiceHeading({name,registration,instance,observation,repository,environmentSwitch,mapDisabled,emptyLabel,onBack,onMap,onCopy}:{name:string;registration?:Service;instance?:Instance;observation?:Observation;repository?:Resource;environmentSwitch:ReactNode;mapDisabled:boolean;emptyLabel?:string;onBack:()=>void;onMap:()=>void;onCopy:()=>void}){
 const inactive=historicalSnapshot(instance)
 const historyState=instance?.lifecycle.stopped_at?'Stopped':observation?.present===false?'Не обнаружен':inactive?'Последний снимок':undefined
 const release=instance?.environment==='prod'&&repository?fieldValue(repository,'Release tag'):undefined
 return <div className="service-heading compact-service-heading"><button className="back-link" onClick={onBack}><ArrowLeft size={14}/>Все сервисы</button>
  <div className="service-title-line"><div className="title-row"><h1>{name}</h1>{release&&<span className="service-heading-release"><LinkedValue value={'Release '+release} href={repository?.fieldLinks?.['Release tag']} target={'релиз '+release}/></span>}{observation?<div className="service-argo-state"><SystemIcon system="argocd" size={20}/><span className={'status tone-'+(inactive?'muted':argoTone(observation.sync,observation.health))}>{historyState?historyState+' · ':''}{observation.sync} · {observation.health}</span><FreshnessBadge compact info={{checkedAt:argoCheckedAt(observation),intervalSeconds:observation.check_interval_seconds,inactive}}/></div>:emptyLabel&&<span className="status tone-muted">{emptyLabel}</span>}</div>
   <div className="service-observation-times"><ObservationTime at={observation?.runtime?.observed_at} inactive={inactive} partial={observation?.runtime?.truncated}/>{observation&&<ObservationTime kind="argo" at={argoCheckedAt(observation)} inactive={inactive}/>}</div>
  </div>
  <div className="service-context-row">{environmentSwitch}<Button variant="outlined" size="small" disableFocusRipple startIcon={<Network size={16}/>} disabled={mapDisabled} onClick={onMap}>Показать карту</Button>{registration&&<span className="service-repository"><SystemIcon system="gitlab" size={17}/><LinkedValue value={'GitLab · #'+registration.project_id} href={repository?.url} target="репозиторий сервиса"/></span>}<InfoTooltip title="Скопировать ссылку на сервис"><IconButton size="small" aria-label="Скопировать ссылку на сервис" onClick={onCopy}><Link2 size={17}/></IconButton></InfoTooltip></div>
 </div>
}
