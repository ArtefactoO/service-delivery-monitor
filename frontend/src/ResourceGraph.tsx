import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ReactFlow, Handle, Position, BaseEdge, EdgeLabelRenderer, MarkerType, MiniMap, type Node, type NodeProps, type Edge, type EdgeProps, type ReactFlowInstance } from '@xyflow/react'
import { Box, Code2, FileCode2, GitPullRequest, Waypoints, Server, Layers3, ShieldCheck, KeyRound, ArrowDown, ArrowRight, ChevronDown, Copy, X, Maximize, Minus, Plus, Link2, Network, Scan } from 'lucide-react'
import { Autocomplete, Button, IconButton, TextField, useMediaQuery } from '@mui/material'
import { InfoTooltip } from '@project/ui/mui'
import { edgeId, type Relationship, type Resource, type ResourceId } from './data'
import { buildComponents } from './components'
import { traceResource } from './graph-selection'
import { edgeColor, edgeFamilies, type EdgeFamily } from './edge-semantics'
import {graphNodeCategories,graphNodeCategory} from './graph-colors'
import { readableViewport, GRAPH_NODE_WIDTH as WIDTH, GRAPH_NODE_HEIGHT as HEIGHT, type GraphCaptionGeometry, type GraphGeometry } from './graph-layout'
import {requestGraphLayout,type LayoutWorker} from './graph-layout-controller'
import { SystemBadge, systemName } from './SystemBadge'
import { ExternalSecretsIcon, HelmIcon } from './ResourceKindIcons'
import { LinkedValue } from './LinkedValue'
import {FieldList,ResourceFieldGroups} from './ResourceFields'
import {resourceCard,resourceFields,fieldValue,resourceSearchText} from './resource-presentation'
import {relationshipEvidence,relationshipDetail} from './relationship-evidence'
import {FreshnessBadge} from './Freshness'
import {graphViewport,nodeInViewport,MINIMAP_WIDTH,MINIMAP_HEIGHT} from './graph-viewport'
import '@xyflow/react/dist/style.css'
import './resource-graph.css'

const icons = { repo: Code2, sourceValues: FileCode2, config: FileCode2, vault: ShieldCheck, image: Box, values: GitPullRequest, chart: HelmIcon, argo: Waypoints, workload: Server, eso: ExternalSecretsIcon, secret: KeyRound, configmap: FileCode2, resource: Layers3, pod: Box, replicaSet: Layers3 }
const DETAILS_WIDTH = 320
const startSvgAnimation=(element:SVGAnimationElement|null)=>element?.beginElement()

type ResourceNode = Node<{ resource: Resource; card:ReturnType<typeof resourceCard>; selected: boolean; related: boolean; dimmed: boolean; keyboardFocusable:boolean; onSelect: (id: ResourceId) => void }, 'resource'>
type ComponentNode = Node<{label:string;count:number;shared:boolean},'component'>
type GraphNode = ResourceNode | ComponentNode
type RelationEdge = Edge<{path:string;active:boolean;dimmed:boolean;family:EdgeFamily;evidence:string;animate:boolean;motionKey:string;animations:{edgeId:string;path:string}[];edgeIds:string[];busId?:string;captions:(GraphCaptionGeometry&{active:boolean})[]}>

function ResourceNodeView({ data }: NodeProps<ResourceNode>) {
  const { resource, card, selected, related, dimmed, onSelect } = data
  const Icon = icons[resource.role], status = card.status
  const category=graphNodeCategory(resource.role)
  const descriptionId=`resource-description-${encodeURIComponent(resource.id)}`
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false}/>
    <button className={`logical-node nodrag nopan ${selected ? 'selected' : related ? 'related' : dimmed ? 'dimmed' : ''}`} data-resource={resource.id} data-category={category} style={{'--graph-node-color':graphNodeCategories[category].color} as CSSProperties} tabIndex={data.keyboardFocusable?0:-1} aria-pressed={selected} aria-label={`${resource.kind}: ${card.title}${card.title!==resource.title?' · '+resource.title:''} · ${systemName(resource.system)}`} aria-describedby={descriptionId} onClick={() => onSelect(resource.id)}>
      <span className="logical-node-heading"><SystemBadge system={resource.system} iconOnly size={20}/><span className="logical-node-kind"><Icon size={16}/>{resource.kind}</span></span>
      <strong title={card.title===resource.title?resource.title:`${resource.title} · ${card.title}`}>{card.title}</strong>
      {card.caption&&<span className="logical-node-meta" title={card.caption}>{card.caption}</span>}
      {status && <span className="logical-node-footer"><span className={`logical-node-status tone-${status.tone}`}><span/>{status.label}</span><FreshnessBadge info={resource.freshness} compact focusable={false}/></span>}
      <span id={descriptionId} className="graph-sr-only">{[card.caption,status?.label].filter(Boolean).join(' · ')}</span>
    </button>
    <Handle type="source" position={Position.Right} isConnectable={false}/>
  </>
}
function ComponentNodeView({data}:NodeProps<ComponentNode>){
  return <div className={`logical-component ${data.shared?'shared':''}`} aria-hidden="true"><span className="logical-component-heading"><Layers3 size={16}/><strong>{data.label}</strong><span>{data.count} resources</span></span></div>
}
function RelationEdgeView({ id, data, markerEnd }: EdgeProps<RelationEdge>) {
  if (!data) return null
  const color = edgeColor(data.family, data.active, data.dimmed)
  return <><g data-render-edge={id} data-logical-edge-ids={JSON.stringify(data.edgeIds)} data-edge-bus={data.busId} data-edge-family={data.family} data-edge-active={data.active || undefined} className={`logical-relation ${data.active?'active':data.dimmed?'dimmed':''}`}>
    <title>{data.evidence}</title>
    <BaseEdge path={data.path} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: data.active ? 3.2 : 1.25, strokeDasharray: edgeFamilies[data.family].dash, strokeLinecap: 'round' }}/>
    {data.active&&data.animate&&data.animations.map(animation=><circle key={`${data.motionKey}:${animation.edgeId}`} data-flow-edge-id={animation.edgeId} className="logical-edge-flow" r="2.7" fill={color} opacity="0" aria-hidden="true"><animateMotion ref={startSvgAnimation} begin="indefinite" path={animation.path} dur="2.2s" repeatCount="2" fill="freeze"/><animate ref={startSvgAnimation} begin="indefinite" attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.95;1" dur="2.2s" repeatCount="2" fill="freeze"/></circle>)}
  </g>{data.captions.map(caption=><Fragment key={caption.id}>{caption.labelLeaderPath&&<path className="logical-caption-leader" d={caption.labelLeaderPath} fill="none" stroke={caption.active?'var(--graph-active-path)':'var(--edge-neutral)'} strokeWidth="1" strokeDasharray="2 3" aria-hidden="true"/>}<EdgeLabelRenderer><span className="logical-edge-label" data-edge-label-id={caption.id} data-edge-label-active={caption.active||undefined} style={{transform:`translate(-50%, -50%) translate(${caption.labelX}px, ${caption.labelY}px)`,color:caption.active?'var(--sl-text)':'var(--sl-muted)',fontWeight:caption.active?600:400}}>{caption.text}</span></EdgeLabelRenderer></Fragment>)}</>
}
const nodeTypes = { resource: ResourceNodeView,component:ComponentNodeView }, edgeTypes = { relation: RelationEdgeView }

type GraphProps={data:Record<ResourceId,Resource>;relationships:Relationship[];selected:ResourceId|null;onSelect:(id:ResourceId|null)=>void;onCopy:(value:string)=>void}
export function ResourceGraph(props:GraphProps){
 const {data,relationships}=props
 const ids=Object.keys(data).sort(),components=buildComponents(data).components
 const structure=JSON.stringify({resources:ids.map(id=>({id,role:data[id].role,kind:data[id].kind,componentIds:data[id].componentIds})),relationships:[...relationships].sort((a,b)=>edgeId(a).localeCompare(edgeId(b))),components:components.map(({id,key})=>({id,key}))})
 const [layout,setLayout]=useState<{structure:string;geometry:GraphGeometry;data:typeof data;relationships:typeof relationships}|null>(null)
 const [error,setError]=useState<string|null>(null),[attempt,setAttempt]=useState(0)
 useEffect(()=>{
  setError(null)
  return requestGraphLayout(structure,()=>new Worker(new URL('./graph-layout.worker.ts',import.meta.url),{type:'module'}) as unknown as LayoutWorker,
   geometry=>setLayout({structure,geometry,data,relationships}),()=>setError(structure))
  // Metadata and selection do not invalidate geometry. The worker receives structural fields only.
 },[structure,attempt])
 const pending=layout?.structure!==structure,failed=error===structure
 const displayed=layout?.structure===structure?{data,relationships}:layout
 return <div className="graph-layout-shell">
  {failed?<div className="graph-layout-message" role="alert">Не удалось построить карту. {layout&&'Показано предыдущее расположение.'}<Button size="small" onClick={()=>setAttempt(value=>value+1)}>Повторить</Button></div>:
   pending&&<div className="graph-layout-message" role="status">{layout?'Обновляем расположение карты…':'Строим карту ресурсов…'}</div>}
  {layout&&displayed&&<ResourceGraphView {...props} data={displayed.data} relationships={displayed.relationships} geometry={layout.geometry}/>}
 </div>
}

function ResourceGraphView({ data, relationships, selected, onSelect, onCopy,geometry }: GraphProps&{geometry:GraphGeometry}) {
  const reducedMotion=useMediaQuery('(prefers-reduced-motion: reduce)')
  const missingResource=!!selected&&!data[selected],activeSelected=missingResource?null:selected
  const ids = Object.keys(data).sort()
  const visibleCategories=Object.entries(graphNodeCategories).filter(([category])=>ids.some(id=>graphNodeCategory(data[id].role)===category))
  const components=buildComponents(data).components
  const [zoom, setZoom] = useState(1), [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 }), [flowReady, setFlowReady] = useState(false)
  const [keyboardView,setKeyboardView]=useState({x:0,y:0,zoom:1})
  const flow = useRef<ReactFlowInstance<GraphNode, RelationEdge> | null>(null)
  const initialized = useRef(false), canvas = useRef<HTMLDivElement>(null), details = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null), openedResource = useRef<ResourceId | null>(null)
  const detailsOpen = !!activeSelected
  useLayoutEffect(() => {
    if (details.current) details.current.scrollTop = 0
  }, [selected])
  useLayoutEffect(() => {
    if (detailsOpen) {
      const active = document.activeElement
      returnFocus.current = active instanceof HTMLElement && active.closest('.logical-map') ? active : null
      openedResource.current = selected
      details.current?.focus({ preventScroll: true })
    } else {
      const node = openedResource.current ? canvas.current?.querySelector<HTMLElement>(`[data-resource="${CSS.escape(openedResource.current)}"]`) : null
      let target = returnFocus.current?.isConnected ? returnFocus.current : node
      if(target?.closest('.logical-flow-area')){
        const bounds=target.getBoundingClientRect(),area=canvas.current!.getBoundingClientRect()
        if(bounds.left<area.left||bounds.top<area.top||bounds.right>area.right||bounds.bottom>area.bottom||
            bounds.right>area.right-MINIMAP_WIDTH-20&&bounds.bottom>area.bottom-MINIMAP_HEIGHT-20)
          target=canvas.current?.closest('.logical-map')?.querySelector<HTMLInputElement>('.graph-resource-picker input')||null
      }
      target?.focus({ preventScroll: true })
      returnFocus.current = null
      openedResource.current = null
    }
  }, [detailsOpen])
  useEffect(() => {
    if (!canvas.current) return
    const observer = new ResizeObserver(([entry]) => setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])
  // The inspector always occupies the same gutter. Opening or closing it never changes
  // the Flow viewport, its bounds, or which resource coordinates can be reached by panning.
  const viewportPolicy=useMemo(()=>graphViewport(geometry,canvasSize.width,canvasSize.height,zoom),[geometry,canvasSize,zoom])
  const minZoom=viewportPolicy.minZoom,translateExtent=viewportPolicy.extent
  const fitMap=()=>{
    if(!flow.current||!canvasSize.width)return
    void flow.current.setViewport(viewportPolicy.fit,{duration:0})
  }
  const readableMap=(resource?:string|null)=>{
    if(!flow.current||!canvasSize.width)return
    void flow.current.setViewport(readableViewport(geometry,canvasSize.width,canvasSize.height,resource),{duration:0})
  }
  useLayoutEffect(()=>{
    if(initialized.current||!flowReady||!canvasSize.width)return
    readableMap(selected)
    initialized.current=true
  },[flowReady,canvasSize,geometry])
  const direct=relationships.filter(edge=>edge.from===selected||edge.to===selected)
  const selection=useMemo(()=>traceResource(activeSelected,relationships,data),[activeSelected,relationships,data])
  const current=selected?data[selected]:null
  const namespace=data.argo?fieldValue(data.argo,'Namespace'):undefined
  const currentStatus=current?resourceCard(current,relationships,namespace).status:undefined
  const pickerGroup=new Map(geometry.groups.flatMap(group=>group.resourceIds.map(id=>[id,group.label] as const)))
  const pickerOptions=[...ids].sort((a,b)=>(pickerGroup.get(a)||'Shared resources').localeCompare(pickerGroup.get(b)||'Shared resources')||data[a].title.localeCompare(data[b].title))
  // Explicit measured dimensions prevent React Flow from unmounting labels during selection.
  const nodes:GraphNode[]=useMemo(()=>[
    ...geometry.groups.map(group=>({id:`group:${group.id}`,type:'component' as const,position:{x:group.x,y:group.y},width:group.width,height:group.height,measured:{width:group.width,height:group.height},style:{width:group.width,height:group.height,pointerEvents:'none' as const},zIndex:-1,draggable:false,selectable:false,focusable:false,data:{label:group.label,count:group.resourceIds.length,shared:!!group.shared}})),
    ...geometry.nodes.filter(node=>data[node.id]).map(node=>({id:node.id,type:'resource' as const,position:{x:node.x,y:node.y},width:WIDTH,height:HEIGHT,measured:{width:WIDTH,height:HEIGHT},draggable:false,selectable:false,zIndex:1,data:{resource:data[node.id],card:resourceCard(data[node.id],relationships,namespace),selected:selected===node.id,related:selection.nodeIds.has(node.id),dimmed:!!activeSelected&&!selection.nodeIds.has(node.id),keyboardFocusable:nodeInViewport(node,WIDTH,HEIGHT,keyboardView,canvasSize),onSelect:(id:ResourceId)=>onSelect(selected===id?null:id)}})),
  ],[geometry,data,relationships,namespace,selected,selection,activeSelected,keyboardView,canvasSize])
  const edges:RelationEdge[]=useMemo(()=>{
    const activeIds=new Set(relationships.filter(edge=>selection.edges.has(edge)).map(edgeId)),byId=new Map(relationships.map(edge=>[edgeId(edge),edge]))
    return geometry.renderEdges.map(edge=>{
      const relation=byId.get(edge.edgeIds[0])!,active=edge.edgeIds.some(id=>activeIds.has(id)),dimmed=!!activeSelected&&!active
      return{id:edge.id,source:edge.from,target:edge.to,type:'relation',markerEnd:edge.arrow?{type:MarkerType.ArrowClosed,color:edgeColor(relation.family,active,dimmed),width:16,height:16,markerUnits:'userSpaceOnUse'}:undefined,data:{path:edge.path,edgeIds:edge.edgeIds,busId:edge.busId,active,dimmed,family:relation.family,evidence:edge.edgeIds.length===1?[relationshipEvidence(relation),relationshipDetail(relation)].filter(Boolean).join(" · "):`${relation.label} · ${edge.edgeIds.length} resource relations`,animate:!reducedMotion,motionKey:activeSelected||"",animations:(edge.animations||[]).filter(a=>activeIds.has(a.edgeId)),captions:edge.captions.map(caption=>({...caption,active:caption.edgeIds.some(id=>activeIds.has(id))}))},selectable:false,zIndex:active?3:0}
    })
  },[geometry,relationships,selection,activeSelected,reducedMotion])

  return <div className="logical-map" style={{ '--details-width': `${DETAILS_WIDTH}px`,'--graph-node-width':`${WIDTH}px`,'--graph-node-height':`${HEIGHT}px`,'--graph-minimap-width':`${MINIMAP_WIDTH}px`,'--graph-minimap-height':`${MINIMAP_HEIGHT}px` } as CSSProperties}>
    <div className="logical-map-toolbar"><div><Network size={17}/><strong>Связи ресурсов</strong><span>{components.length?`${components.length} components · `:''}{ids.length} ресурсов</span></div><Autocomplete className="graph-resource-picker" size="small" options={pickerOptions} filterOptions={(options,{inputValue})=>options.filter(id=>resourceSearchText(data[id]).includes(inputValue.trim().toLocaleLowerCase()))} value={activeSelected} onChange={(_,id)=>onSelect(id)} groupBy={id=>pickerGroup.get(id)||'Shared resources'} getOptionLabel={id=>`${data[id]?.kind||''} · ${data[id]?.title||id}`} renderOption={(props,id)=>{const {key,...optionProps}=props;return <li key={key} {...optionProps}><span className="graph-picker-option"><strong>{data[id]?.title||id}</strong><small>{data[id]?.kind}</small></span></li>}} renderInput={params=><TextField {...params} label="Выбрать ресурс" placeholder="Найти по имени"/>} noOptionsText="Ресурсы не найдены" clearText="Сбросить выбор" openText="Показать ресурсы" closeText="Закрыть список"/><div className="graph-zoom"><InfoTooltip title="Уменьшить"><span><IconButton size="small" aria-label="Уменьшить карту" disabled={zoom<=minZoom+.001} onClick={()=>flow.current?.zoomOut()}><Minus size={16}/></IconButton></span></InfoTooltip><span>{Math.round(zoom*100)}%</span><InfoTooltip title="Увеличить"><span><IconButton size="small" aria-label="Увеличить карту" disabled={zoom>=1.8-.001} onClick={()=>flow.current?.zoomIn()}><Plus size={16}/></IconButton></span></InfoTooltip><Button size="small" startIcon={<Scan size={14}/>} onClick={()=>readableMap(selected)}>{activeSelected?"К выбранному ресурсу":"Читаемый масштаб"}</Button><Button size="small" startIcon={<Maximize size={14}/>} onClick={fitMap}>Вся карта</Button></div></div>
    <div className="logical-canvas" aria-label="Полная карта логических связей">
      <div className="logical-inspector-placeholder"><Network size={22}/>{missingResource?<><strong role="status">Ресурс не найден в текущем снимке</strong><p>Ссылка сохранена. Можно выбрать другой ресурс или сбросить выделение.</p><Button size="small" onClick={()=>onSelect(null)}>Сбросить выделение</Button></>:<><strong>Детали ресурса</strong><p>Выберите ресурс, чтобы увидеть его параметры и всю цепочку связей.</p><small>Перемещайте карту мышью или используйте миникарту.</small></>}</div>
      <div className="logical-flow-area" ref={canvas}><ReactFlow<GraphNode, RelationEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance=>{flow.current=instance;setFlowReady(true)}} onMove={(_,viewport)=>setZoom(viewport.zoom)} onMoveEnd={(_,viewport)=>setKeyboardView(viewport)} minZoom={minZoom} maxZoom={1.8} translateExtent={translateExtent} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} autoPanOnNodeFocus={false} edgesFocusable={false} elementsSelectable={false} zoomOnDoubleClick={false} panOnDrag selectionOnDrag={false} onPaneClick={()=>onSelect(null)} deleteKeyCode={null}>
        <MiniMap ariaLabel="Миникарта полного графа" position="bottom-right" pannable zoomable nodeColor={node=>node.type==='component'?'var(--sl-bg)':node.id===selected?'var(--graph-active-path)':data[node.id]?graphNodeCategories[graphNodeCategory(data[node.id].role)].color:'var(--sl-muted)'} nodeStrokeColor={node=>node.type==='component'?'var(--sl-line-strong)':'transparent'} nodeStrokeWidth={1} nodeBorderRadius={3} maskColor="var(--graph-minimap-mask)"/>
      </ReactFlow></div>
      {current&&<aside className="logical-details" ref={details} tabIndex={-1} aria-label="Детали выбранного ресурса">
        <div className="logical-details-toolbar"><strong>Детали ресурса</strong><IconButton size="small" aria-label="Закрыть детали ресурса" onClick={()=>onSelect(null)}><X size={18}/></IconButton></div>
        <div className="logical-details-heading"><div><div className="logical-details-meta"><span>{current.kind}</span><SystemBadge system={current.system}/></div><h2>{current.title}</h2>{currentStatus&&<span className={`status tone-${currentStatus.tone}`}><span className="status-dot"/>{currentStatus.label}</span>}<FreshnessBadge info={current.freshness}/></div>{current.url&&<LinkedValue value={current.linkLabel} href={current.url} target={current.linkLabel}/>} {!!current.endpoints?.length&&<div className="logical-details-endpoints" aria-label="Адреса Ingress">{current.endpoints.map(endpoint=><LinkedValue key={endpoint.url} value={endpoint.label} href={endpoint.url} target="адрес сервиса"/>)}</div>}</div>
        <div className="logical-details-body"><FieldList resource={current} fields={resourceFields(current).primary}/><div className="logical-neighbors"><h3>Direct relations</h3>{direct.length?direct.map(edge=>{const next=edge.from===selected?edge.to:edge.from,DirectionIcon=edge.from===selected?ArrowRight:ArrowDown;return <button key={edgeId(edge)} onClick={()=>onSelect(next)}><span className="relation-direction"><DirectionIcon size={15} style={{color:edgeFamilies[edge.family].color}}/><span>{edge.label}</span></span><span><strong>{data[next]?.title||next}</strong><small>{data[next]?.kind} · {relationshipEvidence(edge)}</small>{relationshipDetail(edge)&&<small>{relationshipDetail(edge)}</small>}</span><Link2 size={14}/></button>}):<p className="developer-note">Прямые связи не найдены.</p>}</div><details className="resource-extra" key={current.id}><summary><ChevronDown size={14}/>Дополнительно</summary><ResourceFieldGroups resources={[current]}/><Button size="small" startIcon={<Copy size={14}/>} onClick={()=>onCopy(current.identity)}>Копировать идентификатор</Button></details></div>
      </aside>}
    </div>
    <div className="logical-map-key"><div className="graph-legends"><div className="node-legend" aria-label="Категории ресурсов">{visibleCategories.map(([key,category])=><span key={key}><span className="node-category-mark" style={{background:category.color}}/>{category.label}</span>)}</div><div className="edge-legend" aria-label="Relationship types">{Object.entries(edgeFamilies).map(([key,family])=><span key={key}><svg width="28" height="12" aria-hidden="true"><line x1="2" y1="6" x2="26" y2="6" stroke="var(--sl-muted)" strokeWidth="1.8" strokeDasharray={family.dash} strokeLinecap="round"/></svg>{family.label}</span>)}</div></div><span className="logical-selection" aria-live="polite">{current?<><strong>{current.kind}</strong> · связи ресурса · {selection.edges.size} связей <button onClick={()=>onSelect(null)} aria-label="Сбросить выбор"><X size={14}/></button></>:'Выберите ресурс, чтобы выделить его связи'}</span></div>
  </div>
}
