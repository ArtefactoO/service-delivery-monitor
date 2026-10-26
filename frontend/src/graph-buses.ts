import {simplifyRoute} from './graph-routing.ts'

interface Point{x:number;y:number}
interface Node extends Point{id:string}
interface Group extends Point{id:string;width:number;height:number;resourceIds:string[]}
export interface BusLink{id:string;from:string;to:string;label:string;family?:string}
export interface BusRoute extends BusLink{busId:string;points:Point[];path:string;captionPath:string;labelX:number;labelY:number}
export interface RenderPath{id:string;from:string;to:string;path:string;edgeIds:string[];arrow:boolean;animations?:{edgeId:string;path:string}[];busId?:string}
const path=(points:Point[])=>points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ')
const overlap=(lo:number,hi:number,a:number,b:number)=>lo<b&&hi>a
const offsets=[16,24,32,40,48,56,8,64,72,80]

const MIN_BUS_CONNECTIONS=3

/** A typed port with enough connections can branch or converge, regardless of resource kind. */
export function planResourceBuses(links:BusLink[],nodes:Node[],groups:Group[],width:number,height:number,ports:{starts:Map<string,Point>;ends:Map<string,Point>}){
 const membership=new Map(groups.flatMap(g=>g.resourceIds.map(id=>[id,g] as const)))
 for(const n of nodes)if(!membership.has(n.id))membership.set(n.id,{id:`node:${n.id}`,x:n.x-24,y:n.y-76,width:width+48,height:height+100,resourceIds:[n.id]})
 const candidates=new Map<string,{incoming:boolean;edges:BusLink[]}>()
 for(const edge of links)for(const incoming of [false,true]){
  const key=JSON.stringify([incoming?'in':'out',incoming?edge.to:edge.from,edge.label,edge.family])
  const candidate=candidates.get(key)||{incoming,edges:[]};candidate.edges.push(edge);candidates.set(key,candidate)
 }
 // Largest sets win when a relationship could belong to both a fan-in and a fan-out.
 const defs=[...candidates].filter(([,c])=>c.edges.length>=MIN_BUS_CONNECTIONS)
  .sort((a,b)=>b[1].edges.length-a[1].edges.length||a[0].localeCompare(b[0]))
 type Track={x:number;lo:number;hi:number}
 type Band={y:number;lo:number;hi:number}
 const vertical:Track[]=[],horizontal:Band[]=[],result=new Map<string,BusRoute>()
 for(const [key,{incoming,edges:all}] of defs){
  const edges=all.filter(e=>!result.has(e.id)).sort((a,b)=>a.id.localeCompare(b.id))
  if(edges.length<MIN_BUS_CONNECTIONS)continue
  // Reversing direction and mirroring X lets both port directions use the same planner.
  const xWorld=(x:number)=>incoming?-x:x,pointWorld=(p:Point)=>({x:xWorld(p.x),y:p.y})
  const positions=new Map(nodes.map(n=>[n.id,{...n,x:incoming?-n.x-width:n.x}]))
  const branchId=(edge:BusLink)=>incoming?edge.from:edge.to
  const source=positions.get(incoming?edges[0].to:edges[0].from)!
  const commonPorts=edges.map(e=>(incoming?ports.ends:ports.starts).get(e.id)!)
  const start={x:source.x+width,y:commonPorts.reduce((sum,p)=>sum+p.y,0)/commonPorts.length}
  const targets=edges.map(e=>membership.get(branchId(e))!)
  const lo=Math.min(start.y,...targets.map(g=>g.y+40)),hi=Math.max(start.y,...targets.map(g=>g.y+g.height-4))
  const ownVertical:Track[]=[],ownHorizontal:Band[]=[]
  const freeTrack=(x:number,lo:number,hi:number)=>![...vertical,...ownVertical].some(v=>Math.abs(v.x-xWorld(x))<7.9&&overlap(lo,hi,v.lo,v.hi))
  const reserveTrack=(x:number,lo:number,hi:number)=>ownVertical.push({x:xWorld(x),lo,hi})
  const spine=offsets.map(d=>source.x+width+d).find(x=>freeTrack(x,lo,hi))
  if(spine===undefined)continue
  reserveTrack(spine,lo,hi)
  const grouped=new Map<string,BusLink[]>()
  for(const edge of edges){const id=membership.get(branchId(edge))!.id;grouped.set(id,[...(grouped.get(id)||[]),edge])}
  const pending:{edge:BusLink;points:Point[];band:number}[]=[]
  for(const members of grouped.values()){
   const group=membership.get(branchId(members[0]))!,lo=group.y+40,hi=group.y+group.height-4,taps=new Map<number,number>()
   for(const column of [...new Set(members.map(e=>positions.get(branchId(e))!.x))].sort((a,b)=>a-b)){
    const x=offsets.map(d=>column-d).find(x=>freeTrack(x,lo,hi))
    if(x!==undefined){taps.set(column,x);reserveTrack(x,lo,hi)}
   }
   if(members.some(e=>!taps.has(positions.get(branchId(e))!.x)))continue
   const left=Math.min(...[spine,...taps.values()].map(xWorld)),right=Math.max(...[spine,...taps.values()].map(xWorld))
   const bands=[...new Set([...members.map(e=>(incoming?ports.starts:ports.ends).get(e.id)!.y),start.y,
    ...[44,52,60,68].map(y=>group.y+y),group.y+group.height-20,group.y+group.height-12,group.y+group.height-4])].filter(y=>y>=lo&&y<=hi)
   const options=bands.filter(y=>![...horizontal,...ownHorizontal].some(h=>Math.abs(h.y-y)<7.9&&overlap(left,right,h.lo,h.hi))).map(band=>{
    const routes=members.flatMap(edge=>{
     const end=pointWorld((incoming?ports.starts:ports.ends).get(edge.id)!),tap=taps.get(positions.get(branchId(edge))!.x)!
     const oriented=simplifyRoute([start,{x:spine,y:start.y},{x:spine,y:band},{x:tap,y:band},{x:tap,y:end.y},end])
     const points=oriented.map(pointWorld);if(incoming)points.reverse()
     const blocked=points.slice(1).some((b,i)=>nodes.some(n=>{
      const a=points[i],pad=n.id===edge.from||n.id===edge.to?0:4
      return a.y===b.y?a.y>n.y-pad&&a.y<n.y+height+pad&&Math.min(a.x,b.x)<n.x+width+pad&&Math.max(a.x,b.x)>n.x-pad:
       a.x>n.x-pad&&a.x<n.x+width+pad&&Math.min(a.y,b.y)<n.y+height+pad&&Math.max(a.y,b.y)>n.y-pad
     }))
     return blocked?[]:[{edge,points,band}]
    })
    const score=routes.reduce((sum,route)=>sum+route.points.slice(1).reduce((length,p,i)=>length+Math.abs(p.x-route.points[i].x)+Math.abs(p.y-route.points[i].y),0)+(route.points.length-2)*10,0)
    return{band,routes,score}
   }).filter(option=>option.routes.length).sort((a,b)=>b.routes.length-a.routes.length||a.score-b.score||a.band-b.band)
   const chosen=options[0]
   if(!chosen)continue
   ownHorizontal.push({y:chosen.band,lo:left,hi:right})
   pending.push(...chosen.routes)
  }
  if(pending.length<MIN_BUS_CONNECTIONS)continue
  vertical.push(...ownVertical);horizontal.push(...ownHorizontal)
  // The caption belongs to the common prefix (fan-out) or suffix (fan-in).
  const bands=pending.map(p=>p.band),commonY=bands.every(y=>y>=start.y)?Math.min(...bands):bands.every(y=>y<=start.y)?Math.max(...bands):start.y
  const common=simplifyRoute([start,{x:spine,y:start.y},{x:spine,y:commonY}]).map(pointWorld)
  if(incoming)common.reverse()
  const a=common[0],b=common.at(-1)!,labelX=(a.x+b.x)/2,labelY=(a.y+b.y)/2-14,busId=`bus:${key}`
  for(const {edge,points} of pending)result.set(edge.id,{...edge,busId,points,path:path(points),captionPath:path(common),labelX,labelY})
 }
 return result
}

/** Split collinear shared sections at every junction and keep exact owner membership. */
export function splitBusRoutes(routes:BusRoute[]):RenderPath[]{
 const buses=new Map<string,BusRoute[]>()
 for(const route of routes)buses.set(route.busId,[...(buses.get(route.busId)||[]),route])
 const parts:RenderPath[]=[]
 for(const [busId,members] of buses){
  const axes=new Map<string,{horizontal:boolean;constant:number;segments:{lo:number;hi:number;route:BusRoute;forward:boolean;terminal:boolean;end:number}[]}>()
  for(const route of members)for(let i=1;i<route.points.length;i++){
   const a=route.points[i-1],b=route.points[i],horizontal=a.y===b.y,constant=horizontal?a.y:a.x,from=horizontal?a.x:a.y,to=horizontal?b.x:b.y
   if(from===to)continue
   const key=`${horizontal?'H':'V'}:${constant}`,axis=axes.get(key)||{horizontal,constant,segments:[]}
   axis.segments.push({lo:Math.min(from,to),hi:Math.max(from,to),route,forward:to>from,terminal:i===route.points.length-1,end:to});axes.set(key,axis)
  }
  for(const [key,axis] of [...axes].sort(([a],[b])=>a.localeCompare(b))){
   const cuts=[...new Set(axis.segments.flatMap(s=>[s.lo,s.hi]))].sort((a,b)=>a-b)
   for(let i=1;i<cuts.length;i++){
    const lo=cuts[i-1],hi=cuts[i],mid=(lo+hi)/2,owners=axis.segments.filter(s=>s.lo<mid&&s.hi>mid)
    if(!owners.length)continue
    const terminal=owners.find(s=>s.terminal&&(s.end===lo||s.end===hi)),forward=(terminal||owners[0]).forward
    const point=(v:number)=>axis.horizontal?{x:v,y:axis.constant}:{x:axis.constant,y:v}
    const points=[point(forward?lo:hi),point(forward?hi:lo)],edgeIds=[...new Set(owners.map(s=>s.route.id))].sort()
    const owner=(terminal||owners[0]).route
    const animations=owners.filter(s=>s.terminal&&s.end===(forward?hi:lo)).map(s=>({edgeId:s.route.id,path:s.route.path}))
    parts.push({id:`${busId}|${key}:${lo}:${hi}`,busId,from:owner.from,to:owner.to,path:path(points),edgeIds,arrow:!!terminal,animations})
   }
  }
 }
 return parts
}
