import type { Resource, Relationship } from './data'
import {placeEdgeLabels} from './graph-labels.ts'
import {routeLink,type RoutedLink} from './graph-routing.ts'
import {planResourceBuses,splitBusRoutes,type RenderPath} from './graph-buses.ts'
import {dependencyColumns} from './graph-columns.ts'

export const GRAPH_NODE_WIDTH = 224
export const GRAPH_NODE_HEIGHT = 116
const GAP_X = 88, GAP_Y = 28, GROUP_HEADER = 76, GROUP_PADDING = 24, GROUP_GAP = 30
const COLUMN_STEP = GRAPH_NODE_WIDTH + GAP_X, ORIGIN_X = 32, COMPONENT_X = ORIGIN_X + COLUMN_STEP

export interface GraphGroup {id:string;label:string;x:number;y:number;width:number;height:number;resourceIds:string[];shared?:boolean}
export interface GraphPoint {x:number;y:number}
export interface GraphNodeGeometry extends GraphPoint {id:string}
export interface GraphEdgeGeometry {id:string;from:string;to:string;path:string;labelX:number;labelY:number;labelWidth?:number;labelHeight?:number;labelText?:string;labelLeaderPath?:string;labelGroup?:string;busId?:string;captionPath?:string}
export interface GraphCaptionGeometry{ id:string;edgeIds:string[];text:string;labelX:number;labelY:number;labelLeaderPath?:string }
export interface GraphRenderEdge extends RenderPath{captions:GraphCaptionGeometry[]}
export interface GraphGeometry {nodes:GraphNodeGeometry[];edges:GraphEdgeGeometry[];renderEdges:GraphRenderEdge[];groups:GraphGroup[];width:number;height:number}

// Roles are placement preferences; actual dependencies take precedence below.
const componentColumn = (resource: Pick<Resource,'role'|'kind'>) => {
  switch(resource.role){
    case 'image': return 0
    case 'vault': return 2
    case 'eso': case 'configmap': return 3
    case 'secret': return 4
    case 'workload': return 5
    case 'replicaSet': return 6
    case 'pod': return 7
    case 'resource': return resource.kind==='Ingress'?0:resource.kind==='Service'?1:resource.kind==='ServiceAccount'?4:3
    default: return 3
  }
}
const sharedColumn = (resource: Pick<Resource,'role'>) => {
  switch(resource.role){
    case 'config': case 'sourceValues': case 'image': return 0
    case 'values': case 'chart': return 1
    case 'argo': case 'vault': return 2
    case 'secret': return 4
    default: return 3
  }
}
const relationId = (edge:Pick<Relationship,'from'|'to'|'label'>) => `${edge.from}|${edge.label}|${edge.to}`

/** Stable geometry only: revisions, status, selection, and timestamps are deliberately ignored. */
export function layoutResourceGraph(resources:Resource[],relationships:Relationship[],components:{id:string;key:string}[]):GraphGeometry {
  const sorted=[...resources].sort((a,b)=>a.id.localeCompare(b.id)), nodes:GraphNodeGeometry[]=[], groups:GraphGroup[]=[]
  const componentIds=new Set(components.map(component=>component.id))
  const source=sorted.find(resource=>resource.role==='repo')
  const laneResources=new Map<string,Resource[]>(components.map(component=>[component.id,[]]))
  const shared:Resource[]=[],unassigned:Resource[]=[]
  for(const resource of sorted){
    if(resource===source)continue
    const members=(resource.componentIds||[]).filter(id=>componentIds.has(id))
    if(members.length===1)laneResources.get(members[0])!.push(resource)
    else if(members.length>1||['repo','config','sourceValues','values','chart','argo'].includes(resource.role))shared.push(resource)
    else unassigned.push(resource)
  }
  const ordered=[...components].sort((a,b)=>a.key.localeCompare(b.key)).map(component=>({id:component.id,label:component.key,resources:laneResources.get(component.id)||[],shared:false})).filter(group=>group.resources.length)
  if(unassigned.length)ordered.push({id:'unassigned-resources',label:'Other resources',resources:unassigned,shared:false})
  const commonRoles=new Set(['repo','config','sourceValues','values','chart','argo'])
  const preferred=new Map(sorted.filter(resource=>!commonRoles.has(resource.role)).map(resource=>[resource.id,
    unassigned.includes(resource)?3+unassigned.indexOf(resource)%3:componentColumn(resource)]))
  const columnsById=dependencyColumns(preferred,relationships)
  let top=28
  const placeGroup=(id:string,label:string,items:Resource[],isShared:boolean)=>{
    const compact=id==='unassigned-resources',startColumn=compact?3:0
    const columns=new Map<number,Resource[]>()
    items.forEach((resource,index)=>{const column=columnsById.get(resource.id)??(compact?startColumn+index%3:isShared?sharedColumn(resource):componentColumn(resource));columns.set(column,[...(columns.get(column)||[]),resource])})
    const firstColumn=Math.min(startColumn,...columns.keys())
    const maxColumn=Math.max(startColumn,...columns.keys())
    const groupWidth=(maxColumn-firstColumn+1)*COLUMN_STEP-GAP_X+GROUP_PADDING*2
    const maxRows=Math.max(1,...[...columns.values()].map(items=>items.length))
    const contentHeight=maxRows*(GRAPH_NODE_HEIGHT+GAP_Y)-GAP_Y
    const height=GROUP_HEADER+contentHeight+GROUP_PADDING
    groups.push({id,label,x:COMPONENT_X+firstColumn*COLUMN_STEP-GROUP_PADDING,y:top,width:groupWidth,height,resourceIds:items.map(item=>item.id),shared:isShared})
    for(const [column,columnItems]of columns){
      const columnHeight=columnItems.length*(GRAPH_NODE_HEIGHT+GAP_Y)-GAP_Y
      const columnTop=top+GROUP_HEADER+(compact?0:(contentHeight-columnHeight)/2)
      columnItems.forEach((resource,index)=>nodes.push({id:resource.id,x:COMPONENT_X+column*COLUMN_STEP,y:columnTop+index*(GRAPH_NODE_HEIGHT+GAP_Y)}))
    }
    top+=height+GROUP_GAP
  }
  if(shared.length)placeGroup('shared-resources','Shared resources',shared,true)
  for(const group of ordered)placeGroup(group.id,group.label,group.resources,false)
  const height=Math.max(GRAPH_NODE_HEIGHT+56,top-GROUP_GAP+28)
  if(source)nodes.push({id:source.id,x:ORIGIN_X,y:(height-GRAPH_NODE_HEIGHT)/2})
  const width=groups.length?Math.max(...groups.map(group=>group.x+group.width))+28:GRAPH_NODE_WIDTH+ORIGIN_X*2
  const positions=new Map(nodes.map(node=>[node.id,node]))
  const nodeGroups=new Map(groups.flatMap(group=>group.resourceIds.map(id=>[id,group] as const)))
  const orderedEdges=relationships.filter(edge=>positions.has(edge.from)&&positions.has(edge.to)).sort((a,b)=>relationId(a).localeCompare(relationId(b)))
  const boxes=nodes.map(node=>({...node,width:GRAPH_NODE_WIDTH,height:GRAPH_NODE_HEIGHT}))
  const port=(edge:Relationship,side:'from'|'to')=>{
    const peers=orderedEdges.filter(other=>other[side]===edge[side]),index=peers.findIndex(other=>relationId(other)===relationId(edge))
    return(index-(peers.length-1)/2)*Math.min(5,(GRAPH_NODE_HEIGHT-38)/Math.max(1,peers.length-1))
  }
  const labels=new Map(orderedEdges.map(edge=>[relationId(edge),edge.label]))
  const starts=new Map(orderedEdges.map(edge=>{const from=positions.get(edge.from)!;return[relationId(edge),{x:from.x+GRAPH_NODE_WIDTH,y:from.y+GRAPH_NODE_HEIGHT/2+port(edge,'from')}] as const}))
  const ends=new Map(orderedEdges.map(edge=>{const to=positions.get(edge.to)!;return[relationId(edge),{x:to.x,y:to.y+GRAPH_NODE_HEIGHT/2+port(edge,'to')}] as const}))
  const buses=planResourceBuses(orderedEdges.map(edge=>({...edge,id:relationId(edge)})),nodes,groups,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,{starts,ends})
  const busParts=splitBusRoutes([...buses.values()])
  const routed:RoutedLink[]=busParts.map(part=>({from:part.from,to:part.to,label:labels.get(part.edgeIds[0])!,points:[...part.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))}))
  const routes:GraphEdgeGeometry[]=orderedEdges.map(edge=>{
    const bus=buses.get(relationId(edge))
    if(bus)return{...bus,labelGroup:bus.busId}
    const from=positions.get(edge.from)!,to=positions.get(edge.to)!
    const start={x:from.x+GRAPH_NODE_WIDTH,y:from.y+GRAPH_NODE_HEIGHT/2+port(edge,'from')},end={x:to.x,y:to.y+GRAPH_NODE_HEIGHT/2+port(edge,'to')}
    const targetGroup=nodeGroups.get(edge.to)
    const sourceGroup=nodeGroups.get(edge.from)
    const bands=[targetGroup,sourceGroup].filter(Boolean).flatMap(group=>[group!.y+46,group!.y+58,group!.y+group!.height-12])
    const route=routeLink(edge,start,end,boxes,[...bands,12,height-12],routed)
    routed.push({...edge,points:route.points})
    return{id:relationId(edge),from:edge.from,to:edge.to,path:route.path,labelX:route.labelX,labelY:route.labelY}
  })
  const owners=new Map<string,{route:GraphEdgeGeometry;edgeIds:string[]}>()
  for(const route of routes){const key=route.busId||route.id,owner=owners.get(key);if(owner)owner.edgeIds.push(route.id);else owners.set(key,{route,edgeIds:[route.id]})}
  const captions=placeEdgeLabels([...owners.values()].map(({route})=>({...route,path:route.captionPath||route.path})),nodes,groups,labels,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT,routes)
  const captionByKey=new Map(captions.map(c=>[c.busId||c.id,c]))
  const edges=routes.map(route=>{const caption=captionByKey.get(route.busId||route.id)!;return{...route,labelX:caption.labelX,labelY:caption.labelY,labelWidth:caption.labelWidth,labelHeight:caption.labelHeight,labelText:caption.labelText,labelLeaderPath:caption.labelLeaderPath}})
  const renderEdges:GraphRenderEdge[]=[...busParts,...routes.filter(r=>!r.busId).map(r=>({id:r.id,from:r.from,to:r.to,path:r.path,edgeIds:[r.id],arrow:true,animations:[{edgeId:r.id,path:r.path}]}))].map(part=>({...part,captions:[]}))
  const slots=new Map<string,GraphCaptionGeometry>()
  for(const caption of captions){
    const ids=owners.get(caption.busId||caption.id)!.edgeIds,key=JSON.stringify([caption.labelGroup||caption.labelText,caption.labelX,caption.labelY]),prior=slots.get(key)
    if(prior)prior.edgeIds=[...new Set([...prior.edgeIds,...ids])]
    else slots.set(key,{id:caption.id,edgeIds:ids,text:caption.labelText,labelX:caption.labelX,labelY:caption.labelY,labelLeaderPath:caption.labelLeaderPath})
  }
  for(const caption of slots.values()){
    const owner=renderEdges.find(e=>e.arrow&&e.edgeIds.includes(caption.id))||renderEdges.find(e=>e.edgeIds.includes(caption.id))
    owner?.captions.push(caption)
  }
  return{nodes,edges,renderEdges,groups,width:Math.max(width,...edges.map(e=>e.labelX+(e.labelWidth||0)/2+28)),height:Math.max(height,...edges.map(e=>e.labelY+(e.labelHeight||0)/2+28))}
}

export function readableViewport(geometry:GraphGeometry,width:number,height:number,selected?:string|null){
  const zoom=.95
  const target=geometry.nodes.find(node=>node.id===selected)||geometry.nodes.find(node=>node.id==='repo')||geometry.nodes[0]
  return{x:32-(target?.x||0)*zoom,y:height/2-((target?.y||0)+GRAPH_NODE_HEIGHT/2)*zoom,zoom}
}
