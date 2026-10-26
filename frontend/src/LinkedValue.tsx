import {ArrowUpRight} from 'lucide-react'
import {InfoTooltip} from '@project/ui/mui'

export function LinkedValue({value,href,target}:{value:string;href?:string;target?:string}){
 if(!href)return <span>{value}</span>
 const label=target||value,action=/^Открыть\s+/i.test(label)?label:`Открыть ${label}`
 return <InfoTooltip title={`${action} · новая вкладка`} describeChild><a className="sheet-value-link" href={href} target="_blank" rel="noopener noreferrer"><span>{value}</span><ArrowUpRight size={13}/></a></InfoTooltip>
}

export function UnknownVersion({label,reason}:{label:string;reason?:string|null}){
 const detail=label+' не подтверждена для наблюдаемой сборки.'+(reason?` Код проверки: ${reason}.`:'')
 return <InfoTooltip title={detail} describeChild><span className="version-unavailable" aria-label={detail}>Нет данных</span></InfoTooltip>
}
