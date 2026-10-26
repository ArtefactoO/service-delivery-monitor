import { Button, Chip, FormControl, InputLabel, MenuItem, Select } from '@mui/material'
import { InfoTooltip } from '@project/ui/mui'
import { Clock3, GitBranch, Timer, TimerOff } from 'lucide-react'
import { age, type Instance, type Life } from './data'
import {useFreshnessClock} from './Freshness'
import {featureSchedule,featureSelectionLabel,featureUptimeSeconds} from './feature-context'

function lifetime(instance: {lifecycle:Life;lifetime_seconds?:number|null},now:number) {
  const seconds=featureUptimeSeconds(instance,now)
  return seconds===undefined?'Uptime неизвестен':`Uptime ${age(seconds)}`
}

export function Lifetime({instance,focusable=false}: {instance: {lifecycle: Life;lifetime_seconds?:number|null};focusable?:boolean}) {
  const now=useFreshnessClock()
  return <InfoTooltip title="Время с момента создания feature Application. Перезапуски Pods не обнуляют счетчик." describeChild>
    <Chip className="feature-age" variant="outlined" size="small" tabIndex={focusable?0:undefined} icon={<Clock3 size={14}/>} label={lifetime(instance,now)}/>
  </InfoTooltip>
}

export function FeatureStopSchedule({lifecycle,inactive=false}:{lifecycle:Life;inactive?:boolean}){
  const schedule=featureSchedule(lifecycle,useFreshnessClock(),inactive)
  if(!schedule)return null
  const exact=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'long'}).format(new Date(schedule.at))
  const short=new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(schedule.at))
  const stopped=schedule.kind==='stopped',overdue=schedule.kind==='overdue'
  const label=stopped?`Остановлена ${short}`:overdue?`Auto-stop просрочен на ${age(schedule.seconds)}`:`Auto-stop через ${age(schedule.seconds)}`
  const tooltip=stopped?`Фактическая остановка feature: ${exact}.`:`Плановая остановка feature: ${exact}. ${overdue?'Срок прошел; фактическая остановка пока не подтверждена.':'Чип показывает время до плановой остановки.'} Состояние Argo показано отдельно.`
  return <InfoTooltip title={tooltip} describeChild><Chip className={`feature-stop${overdue?' overdue':''}`} variant="outlined" size="small" tabIndex={0} icon={stopped?<TimerOff size={14}/>:<Timer size={14}/>} label={label}/></InfoTooltip>
}

export function FeatureContext({instance, choices, onChange}: {instance?: Instance; choices: Instance[]; onChange: (name: string) => void}) {
  const now=useFreshnessClock()
  if (!instance && !choices.length) return null
  const activeChoice = choices.some(item => item.name === instance?.name)
  const historical = !!instance && !activeChoice
  const selection=instance?featureSelectionLabel(instance,choices):undefined
  return <div className="feature-context">
    {choices.length > 1 ? <FormControl size="small" className="feature-choice">
      <InputLabel id="feature-choice-label" shrink>Feature-окружение</InputLabel>
      <Select labelId="feature-choice-label" label="Feature-окружение" value={instance?.name || ''} displayEmpty onChange={event => onChange(event.target.value)}
        renderValue={() => <span className="feature-branch"><GitBranch size={14}/><span>{selection?.branch||'Выберите feature'}</span>{selection?.hint&&<small className="feature-instance-hint">{selection.hint}</small>}</span>}
        MenuProps={{PaperProps: {className: 'feature-menu', sx: {maxHeight: 300, maxWidth: 600}}}}>
        {historical && <MenuItem value={instance.name} disabled>Последний снимок · {instance.source_ref}</MenuItem>}
        {choices.map(item => {const label=featureSelectionLabel(item,choices),created=item.lifecycle.created_at,validCreated=created&&Number.isFinite(Date.parse(created));return <MenuItem key={item.id} value={item.name} className={`feature-option${label.hint?'':' single-line'}`}><span className="feature-option-text"><strong>{label.branch}</strong>{label.hint&&<small>{label.hint}{validCreated&&` · ${new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(created))}`}</small>}</span><span className="feature-option-age">{lifetime(item,now)}</span></MenuItem>})}
      </Select>
    </FormControl> : instance && <InfoTooltip title={selection!.tooltip} describeChild><Chip className="feature-branch-chip" size="small" tabIndex={0} icon={<GitBranch size={15}/>} label={<span className="feature-branch"><span>{selection!.branch}</span>{selection!.hint&&<small className="feature-instance-hint">{selection!.hint}</small>}</span>} variant="outlined"/></InfoTooltip>}
    {instance && <Lifetime instance={instance} focusable/>}
    {instance && <FeatureStopSchedule lifecycle={instance.lifecycle} inactive={historical}/>}
    {choices.length === 1 && !activeChoice && <Button size="small" startIcon={<GitBranch size={15}/>} onClick={() => onChange(choices[0].name)}>Открыть {choices[0].source_ref}</Button>}
  </div>
}
