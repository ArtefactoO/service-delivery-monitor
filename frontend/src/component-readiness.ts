import {fieldValue} from './resource-presentation.ts'
import type {Resource,Tone} from './data.ts'

const count=(resource:Resource,name:string)=>{
 const value=fieldValue(resource,name)
 return value!==undefined&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):undefined
}
export function workloadCount(resources:Resource[],name:string){
 const values=resources.map(resource=>count(resource,name))
 return values.length&&values.every(value=>value!==undefined)?values.reduce<number>((sum,value)=>sum+value!,0):undefined
}
export function componentReadiness(workloads:Resource[]):{label:string;tone:Tone;detail:string}{
 const unknown={label:'Не подтверждено',tone:'muted' as const,detail:'ArgoCD не передал полные данные готовности workload.'}
 if(!workloads.length)return unknown
 if(workloads.some(resource=>resource.status?.label==='Last snapshot'))return {label:'Последний снимок',tone:'muted',detail:'Готовность сохранена в технических данных. Этот снимок не подтверждает текущее состояние ресурсов.'}
 if(workloads.every(resource=>resource.kind==='Job')){
  const failed=workloadCount(workloads,'Failed Jobs'),active=workloadCount(workloads,'Active Jobs'),succeeded=workloadCount(workloads,'Succeeded Jobs')
  const detail='Результат Job из наблюдаемого runtime ArgoCD. Статус ArgoCD показан отдельно.'
  if(failed!==undefined&&failed>0)return {label:`${failed} failed`,tone:'danger',detail}
  if(active!==undefined&&active>0)return {label:`${active} active`,tone:'warn',detail}
  if(succeeded!==undefined&&succeeded>0)return {label:`${succeeded} succeeded`,tone:'ok',detail}
  return active===0?{label:'0 active',tone:'muted',detail}:unknown
 }
 if(workloads.some(resource=>resource.kind==='Job'))return {label:'Разные workloads',tone:'muted',detail:'Компонент содержит Job и контроллер. Их готовность показана отдельно в технических данных.'}
 const ready=workloadCount(workloads,'Ready replicas'),target=workloadCount(workloads,'Target replicas')
 if(ready===undefined||target===undefined)return unknown
 if(target===0&&ready===0)return {label:'0 / 0 · scaled to zero',tone:'muted',detail:'Ожидаемое число реплик равно нулю. Это не подтверждает Health ArgoCD.'}
 return {label:`${ready} / ${target} Ready`,tone:target===0?'warn':ready>=target?'ok':ready>0?'warn':'danger',detail:`Готово ${ready} из ${target} ожидаемых реплик. Метрика не меняет статус ArgoCD.`}
}
