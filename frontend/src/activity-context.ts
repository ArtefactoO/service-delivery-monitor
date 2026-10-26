import type {DeliveryPayload,Observation} from './data'

/** History links remain valid when an instance has disappeared from the active catalog. */
export function serviceHistoryHref(service:string,environment?:string,instance?:string,historyRef?:string){
 const query=new URLSearchParams({page:'service',service,tab:'history'})
 if(historyRef)query.set('history_ref',historyRef)
 else{
  if(environment)query.set('env',environment)
  if(instance)query.set('instance',instance)
 }
 return `/?${query}`
}

const date=(value?:string)=>{const parsed=value?Date.parse(value):NaN;return Number.isFinite(parsed)?new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'long'}).format(new Date(parsed)):undefined}
export function ciAttemptDetails(payload:DeliveryPayload,observation?:Observation){
 const occurred=date(payload.occurred_at),details=[occurred?`Время события CI: ${occurred}.`:'Время события CI не передано.',`Ветка попытки: ${payload.source.ref}.`,`Source revision попытки: ${payload.source.revision}.`]
 if(payload.publication?.revision)details.push(`Revision этой публикации: ${payload.publication.revision}.`)
 if(observation?.git.source_revision)details.push(`Source revision в последнем снимке Argo: ${observation.git.source_revision}.`)
 if(observation?.git.build_revision)details.push(`Build revision image в последнем снимке Argo: ${observation.git.build_revision}.`)
 if(payload.failure_code)details.push(`Код результата CI: ${payload.failure_code}.`)
 details.push('Это результат отдельной попытки CI. Он не заменяет текущий Health Argo или состояние Pods; revision попытки может отличаться от наблюдаемой публикации.')
 return details.join('\n')
}
