import {InfoTooltip} from '@project/ui/mui'
import {age} from './data'
import {useFreshnessClock} from './Freshness'

const format=new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'long'})
export function ObservationTime({at,kind='resources',inactive=false,partial=false}:{at?:string|null;kind?:'resources'|'argo';inactive?:boolean;partial?:boolean}){
 const now=useFreshnessClock(),time=at?Date.parse(at):NaN,known=Number.isFinite(time)
 const label=kind==='argo'?'ArgoCD':'Last update',description=kind==='argo'?'Проверка Application в ArgoCD':'Проверка ресурсов'
 const value=known?inactive?format.format(time):age(Math.max(0,(now-time)/1000)):'нет данных'
 const detail=(known?`${description}: ${format.format(time)}.${inactive?' Сохраненный снимок, текущее состояние не подтверждено.':''}`:`${description} еще не получена.`)+(partial?' Снимок ресурсов неполный.':'')
 return <InfoTooltip title={detail} placement="top" describeChild><span className="observation-time" aria-label={detail} tabIndex={0}>{inactive&&kind==='resources'?'Snapshot':label}{kind==='argo'?': ':' '}{value}{partial&&<span className="partial-observation"> · partial</span>}</span></InfoTooltip>
}
