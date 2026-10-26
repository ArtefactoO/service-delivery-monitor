import {LinkedValue} from './LinkedValue'
import {SystemIcon} from './SystemBadge'
import {detailGroups,resourceFields,type ResourceField} from './resource-presentation'
import type {Resource} from './data'
import {FreshnessBadge} from './Freshness'
import './resource-fields.css'

export function FieldList({resource,fields}:{resource:Resource;fields:ResourceField[]}){
 if(!fields.length)return null
 return <dl className="resource-fields">{fields.map(([label,value],index)=><div data-field-name={label} className={value.length<=16?'resource-field-short':undefined} key={`${label}-${index}`}><dt>{label.startsWith('File: ')?'File':resource.role==='values'&&label==='Branch'?'Values branch':label}</dt><dd><LinkedValue value={value} href={resource.fieldLinks?.[label]} target={label}/></dd></div>)}</dl>
}

export function ResourceFieldGroups({resources,mode='inspector',collapsible=false}:{resources:Resource[];mode?:'overview'|'inspector'|'technical';collapsible?:boolean}){
 const entries=resources.map(resource=>({resource,groups:resourceFields(resource,mode).additional}))
 const notes=[...new Set(resources.map(resource=>resource.description).filter(Boolean))]
 return <div className="resource-detail-groups">{detailGroups.map(group=>{
  const items=entries.filter(entry=>entry.groups[group].length)
  if(!items.length&&(group!=='Происхождение'||!notes.length))return null
  const content=<>{items.map(({resource,groups})=><div className="resource-detail-entry" data-resource-id={resource.id} key={resource.id}>{resources.length>1&&<h4><SystemIcon system={resource.system} size={14}/><span>{resource.kind} · {resource.title}</span><FreshnessBadge info={resource.freshness}/></h4>}<FieldList resource={resource} fields={groups[group]}/></div>)}{group==='Происхождение'&&notes.map(note=><p className="developer-note" key={note}>{note}</p>)}</>
  return collapsible?<details className="resource-detail-group technical-field-group" key={group}><summary>{group}<span>{items.reduce((count,item)=>count+item.groups[group].length,0)} полей</span></summary><div className="technical-field-content">{content}</div></details>:<section className="resource-detail-group" key={group}><h3>{group}</h3>{content}</section>
 })}</div>
}
