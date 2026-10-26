interface Point{x:number;y:number}
interface Box extends Point{width:number;height:number}
interface CaptionAnchor{from:Point;to:Point;distance:number}
interface LabelEdge{id:string;from:string;to:string;path:string;labelX:number;labelY:number;labelGroup?:string}
interface Group extends Box{label:string;resourceIds:string[]}
export const edgeLabelSize=(label:string,maxWidth=Infinity)=>{
 const lines:string[]=[]
 for(const word of label.split(' ')){
  const last=lines.at(-1)
  if(last&&(last.length+1+word.length)*7.4+14<=maxWidth)lines[lines.length-1]=last+' '+word
  else lines.push(word)
 }
 return {width:Math.max(0,...lines.map(line=>line.length*7.4+14)),height:lines.length*16+8,text:lines.join('\n')}
}
export const boxesOverlap=(a:Box,b:Box,padding=0)=>a.x<b.x+b.width+padding&&a.x+a.width>b.x-padding&&a.y<b.y+b.height+padding&&a.y+a.height>b.y-padding
const CARD_GAP=1,LABEL_GAP=2
export function edgeLabelGroups(edges:{id:string;labelText?:string;labelX:number;labelY:number}[]){
 const groups=new Map<string,string[]>()
 for(const edge of edges){const key=JSON.stringify([edge.labelText,edge.labelX,edge.labelY]);groups.set(key,[...(groups.get(key)||[]),edge.id])}
 return new Map(edges.map(edge=>[edge.id,groups.get(JSON.stringify([edge.labelText,edge.labelX,edge.labelY]))!]))
}

/** Free intervals are label-center coordinates, including the whole label box. */
function freeIntervals(lo:number,hi:number,blocked:[number,number][]){
 const intervals:[number,number][]=[]
 let cursor=lo
 for(const [start,end]of blocked.filter(([start,end])=>end>=lo&&start<=hi).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
  if(start>cursor)intervals.push([cursor,Math.min(hi,start)])
  cursor=Math.max(cursor,end)
  if(cursor>hi)return intervals
 }
 if(cursor<=hi)intervals.push([cursor,hi])
 return intervals
}

/** Labels use free route segments; every test includes source and target cards. */
export function placeEdgeLabels<T extends LabelEdge>(edges:T[],nodes:(Point&{id:string})[],groups:Group[],labels:Map<string,string>,nodeWidth:number,nodeHeight:number,wireEdges:LabelEdge[]=edges){
 const obstacles:Box[]=[...nodes.map(node=>({...node,width:nodeWidth,height:nodeHeight})),...groups.map(group=>({x:group.x+20,y:group.y+13,width:Math.min(group.width-40,group.label.length*9+95),height:24}))]
 const frames:Box[]=groups.flatMap(group=>[
  {x:group.x,y:group.y,width:group.width,height:1},{x:group.x,y:group.y+group.height-1,width:group.width,height:1},
  {x:group.x,y:group.y,width:1,height:group.height},{x:group.x+group.width-1,y:group.y,width:1,height:group.height}
 ])
 const routes=wireEdges.map(edge=>({id:edge.id,label:edge.labelGroup||labels.get(edge.id)||'',points:[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))}))
 const used:(Box&{label:string})[]=[]
 return edges.map(edge=>{
  const label=labels.get(edge.id)||'',scope=edge.labelGroup||label,source=nodes.find(node=>node.id===edge.from),target=nodes.find(node=>node.id===edge.to)
  const gap=source&&target?target.x-source.x-nodeWidth:0
  const size=edgeLabelSize(label,gap>0&&gap<=100?gap-4:Infinity),points=[...edge.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}))
  const offsetY=size.height/2+2
  const candidates:Point[]=[{x:edge.labelX,y:edge.labelY-(size.height-24)/2}]
  const box=(point:Point):Box=>({x:point.x-size.width/2,y:point.y-size.height/2,...size})
  // Opaque caption backgrounds must never cut a different dependency, including
  // one selected later. Anchors depend only on geometry, never on selection.
  const wires:Box[]=routes.filter(route=>route.id!==edge.id&&!(edge.labelGroup&&route.label===edge.labelGroup)).flatMap(route=>route.points.slice(1).map((b,index)=>{
   const a=route.points[index]
   return{x:Math.min(a.x,b.x)-2,y:Math.min(a.y,b.y)-2,width:Math.abs(a.x-b.x)+4,height:Math.abs(a.y-b.y)+4}
  }))
  const clearArea=(point:Point)=>{const bounds=box(point);return (!nodes.length||bounds.x>=0&&bounds.y>=0)&&!obstacles.some(obstacle=>boxesOverlap(bounds,obstacle,CARD_GAP))&&!wires.some(wire=>boxesOverlap(bounds,wire))}
  const clear=(point:Point,avoidLabels=true)=>clearArea(point)&&!!anchor(point)&&(!avoidLabels||!used.some(prior=>boxesOverlap(box(point),prior,LABEL_GAP)&&!(prior.label===scope&&prior.x===box(point).x&&prior.y===box(point).y)))
  const blockers=[...obstacles.map(obstacle=>({box:obstacle,gap:CARD_GAP})),...wires.map(wire=>({box:wire,gap:0})),...used.map(prior=>({box:prior,gap:LABEL_GAP}))]
  const along=(horizontal:boolean,a:Point,b:Point,offset:number)=>{
   const constant=(horizontal?a.y:a.x)+offset,half=horizontal?size.height/2:size.width/2
   const spanHalf=horizontal?size.width/2:size.height/2
   // The caption box may touch the end of a segment without its center being on
   // that segment. This exposes real row gaps beside short local elbows.
   const lo=Math.min(horizontal?a.x:a.y,horizontal?b.x:b.y)-spanHalf-4,hi=Math.max(horizontal?a.x:a.y,horizontal?b.x:b.y)+spanHalf+4
   const blocked:[number,number][]=blockers.filter(({box,gap})=>{
    const start=horizontal?box.y:box.x,length=horizontal?box.height:box.width
    return constant-half<start+length+gap&&constant+half>start-gap
   }).map(({box,gap})=>{const start=horizontal?box.x:box.y,length=horizontal?box.width:box.height;return[start-spanHalf-gap,start+length+spanHalf+gap]})
   const preferred=horizontal?edge.labelX:edge.labelY
   for(const [start,end]of freeIntervals(lo,hi,blocked)){
    for(const value of [Math.max(start,Math.min(end,preferred)),(start+end)/2,start,end])candidates.push(horizontal?{x:value,y:constant}:{x:constant,y:value})
   }
  }
  // Exact duplicate captions can share one point, but only beside this edge.
  for(const prior of used.filter(prior=>prior.label===scope)){
   const center={x:prior.x+prior.width/2,y:prior.y+prior.height/2}
   if(points.slice(1).some((point,index)=>{const start=points[index];return start.x===point.x?center.y>=Math.min(start.y,point.y)&&center.y<=Math.max(start.y,point.y)&&Math.abs(center.x-start.x)<=size.width/2+8:center.x>=Math.min(start.x,point.x)&&center.x<=Math.max(start.x,point.x)&&Math.abs(center.y-start.y)<=14}))candidates.push(center)
  }
  for(let index=1;index<points.length;index++){
   const a=points[index-1],b=points[index]
   if(a.y===b.y){
    for(const fraction of [.5,.25,.75])for(const offset of [-offsetY,offsetY])candidates.push({x:a.x+(b.x-a.x)*fraction,y:a.y+offset})
   }else{
    const lo=Math.min(a.y,b.y),hi=Math.max(a.y,b.y)
    for(const y of [(lo+hi)/2,lo+size.height/2+2,hi-size.height/2-2])if(y>=lo&&y<=hi)for(const sign of [-1,1])candidates.push({x:a.x+sign*(size.width/2+8),y})
   }
  }
  // Search all genuine gaps along every route before widening the local offset.
  for(const extra of [0,16,32,48,64])for(let index=1;index<points.length;index++){
   const a=points[index-1],b=points[index]
   if(a.y===b.y){for(const sign of [-1,1])along(true,a,b,sign*(offsetY+extra))}
   else if(a.x===b.x){for(const sign of [-1,1])along(false,a,b,sign*(size.width/2+8+extra))}
  }
  const group=groups.find(group=>group.resourceIds.includes(edge.to))
  if(group){
   const left=group.x+size.width/2+2,right=group.x+group.width-size.width/2-2,xs=[left,right,Math.max(left,Math.min(right,edge.labelX))]
   for(let x=left;x<=right;x+=Math.max(24,size.width/2))xs.push(x)
   const nearRoute=(point:Point)=>points.slice(1).some((end,index)=>{
    const start=points[index],label=box(point)
    const dx=Math.max(0,label.x-Math.max(start.x,end.x),Math.min(start.x,end.x)-label.x-label.width)
    const dy=Math.max(0,label.y-Math.max(start.y,end.y),Math.min(start.y,end.y)-label.y-label.height)
    return Math.hypot(dx,dy)<=40
   })
   for(const x of xs.sort((a,b)=>Math.abs(a-edge.labelX)-Math.abs(b-edge.labelX)||a-b))for(const offset of [52,40,64]){
    const point={x,y:group.y+offset}
    if(nearRoute(point))candidates.push(point)
   }
  }
  const anchors=new Map<string,CaptionAnchor|undefined>()
  const anchor=(point:Point):CaptionAnchor|undefined=>{
   const key=`${point.x},${point.y}`
   if(anchors.has(key))return anchors.get(key)
   const bounds=box(point)
   const result=points.slice(1).map((b,index)=>{
    const a=points[index],from={x:Math.max(Math.min(a.x,b.x),Math.min(Math.max(a.x,b.x),point.x)),y:Math.max(Math.min(a.y,b.y),Math.min(Math.max(a.y,b.y),point.y))}
    const to={x:Math.max(bounds.x,Math.min(bounds.x+bounds.width,from.x)),y:Math.max(bounds.y,Math.min(bounds.y+bounds.height,from.y))}
    return{from,to,distance:Math.hypot(from.x-to.x,from.y-to.y)}
   }).filter(leader=>{
    const corridor={x:Math.min(leader.from.x,leader.to.x),y:Math.min(leader.from.y,leader.to.y),width:Math.max(.01,Math.abs(leader.from.x-leader.to.x)),height:Math.max(.01,Math.abs(leader.from.y-leader.to.y))}
    return !obstacles.some(obstacle=>boxesOverlap(corridor,obstacle))
   }).sort((a,b)=>a.distance-b.distance)[0]
   anchors.set(key,result);return result
  }
  const choose=()=>{
   // Reject occupied areas before computing expensive leaders for every candidate.
   const unique=[...new Map(candidates.map(point=>[`${point.x},${point.y}`,point])).values()].filter(clearArea)
   const ordered=unique.map(point=>({point,score:(anchor(point)?.distance??Infinity)*4+Math.hypot(point.x-edge.labelX,point.y-edge.labelY)*.03}))
    .sort((a,b)=>a.score-b.score).map(item=>item.point)
   return ordered.find(point=>clear(point,true)&&!frames.some(frame=>boxesOverlap(box(point),frame,1)))||ordered.find(point=>clear(point,true))
  }
  let chosen=choose()
  // Congested maps may need a wider callout. Never fall back onto a card or foreign wire.
  for(const extra of [96,128,192,256,384,512]){
   if(chosen)break
   for(let index=1;index<points.length;index++){
    const a=points[index-1],b=points[index]
    if(a.y===b.y){for(const sign of [-1,1])along(true,a,b,sign*(offsetY+extra))}
    else if(a.x===b.x){for(const sign of [-1,1])along(false,a,b,sign*(size.width/2+8+extra))}
   }
   chosen=choose()
  }
  if(!chosen)throw new Error('No free resource caption')
  const leader=anchor(chosen)
  used.push({...box(chosen),label:scope})
  return {...edge,labelX:chosen.x,labelY:chosen.y,labelWidth:size.width,labelHeight:size.height,labelText:size.text,
   labelLeaderPath:leader&&leader.distance>8?`M ${leader.from.x} ${leader.from.y} L ${leader.to.x} ${leader.to.y}`:undefined}
 })
}
