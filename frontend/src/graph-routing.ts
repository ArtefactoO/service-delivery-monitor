type Point={x:number;y:number}
type Box=Point&{id:string;width:number;height:number}
export interface RoutedLink {from:string;to:string;label:string;points:Point[]}
const length=(points:Point[])=>points.slice(1).reduce((sum,end,index)=>sum+Math.abs(end.x-points[index].x)+Math.abs(end.y-points[index].y),0)
export function simplifyRoute(points:Point[]){
 const result:Point[]=[]
 for(const point of points){
  if(result.at(-1)?.x===point.x&&result.at(-1)?.y===point.y)continue
  while(result.length>1){
   const a=result.at(-2)!,b=result.at(-1)!
   if(a.x===b.x&&b.x===point.x&&(b.y-a.y)*(point.y-b.y)>=0||a.y===b.y&&b.y===point.y&&(b.x-a.x)*(point.x-b.x)>=0)result.pop()
   else break
  }
  result.push(point)
 }
 return result
}
function intersects(a:Point,b:Point,box:Box,pad:number){
 const left=box.x-pad,right=box.x+box.width+pad,top=box.y-pad,bottom=box.y+box.height+pad
 return a.y===b.y?a.y>top&&a.y<bottom&&Math.max(a.x,b.x)>left&&Math.min(a.x,b.x)<right:
  a.x>left&&a.x<right&&Math.max(a.y,b.y)>top&&Math.min(a.y,b.y)<bottom
}
/** Choose a short free orthogonal corridor. Captions never force the wire into a detour. */
export function routeLink(link:{from:string;to:string;label:string},start:Point,end:Point,boxes:Box[],bands:number[],previous:RoutedLink[]=[]){
 const forward=end.x>start.x,candidates:Point[][]=[]
 if(forward&&start.y===end.y)candidates.push([start,end])
 // Every obstacle exposes local gutters. The free row between other cards can be
 // shorter than either endpoint's own boundary or the component's header band.
 const tracks=[8,16,24,32,40]
 const xs=[start.x+16,end.x-16,(start.x+end.x)/2,...boxes.flatMap(box=>[box.x-4,box.x-8,box.x-16,box.x+box.width+4,box.x+box.width+8,box.x+box.width+16])]
 const segmentKey=(a:Point,b:Point)=>`${Math.min(a.x,b.x)},${Math.min(a.y,b.y)}:${Math.max(a.x,b.x)},${Math.max(a.y,b.y)}`
 const clearCache=new Map<string,boolean>()
 const clearSegment=(a:Point,b:Point)=>{
  const key=segmentKey(a,b),known=clearCache.get(key)
  if(known!==undefined)return known
  const result=boxes.every(box=>!intersects(a,b,box,box.id===link.from||box.id===link.to?0:4))
  clearCache.set(key,result);return result
 }
 if(forward)for(const x of new Set(xs)){
  if(x<start.x||x>end.x)continue
  candidates.push([start,{x,y:start.y},{x,y:end.y},end])
 }
 const own=boxes.filter(box=>box.id===link.from||box.id===link.to)
 const ys=[start.y,end.y,(start.y+end.y)/2,...own.flatMap(box=>[box.y-16,box.y+box.height+16]),...bands,
  ...boxes.flatMap(box=>[box.y-4,box.y-12,box.y+box.height+4,box.y+box.height+12])]
 const visibleExits=forward?[...new Set(xs)].filter(x=>x>start.x&&x<end.x&&clearSegment(start,{x,y:start.y})).sort((a,b)=>a-b).slice(-3):[]
 const visibleEntries=forward?[...new Set(xs)].filter(x=>x>start.x&&x<end.x&&clearSegment({x,y:end.y},end)).sort((a,b)=>a-b).slice(0,3):[]
 const outlets=[...new Set([...tracks.map(offset=>start.x+offset),...visibleExits])].filter(x=>clearSegment(start,{x,y:start.y}))
 const inlets=[...new Set([...tracks.map(offset=>end.x-offset),...visibleEntries])].filter(x=>clearSegment({x,y:end.y},end))
 for(const y of new Set(ys))for(const outlet of outlets)for(const inlet of inlets){
  if(forward&&outlet>inlet)continue
  candidates.push([start,{x:outlet,y:start.y},{x:outlet,y},{x:inlet,y},{x:inlet,y:end.y},end])
 }
 const clear=(points:Point[])=>points.slice(1).every((end,index)=>clearSegment(points[index],end))
 const priorSegments=previous.filter(route=>!(route.from===link.from&&route.label===link.label||route.to===link.to&&route.label===link.label))
  .flatMap(route=>route.points.slice(1).map((d,index)=>({c:route.points[index],d})))
 const congestionCache=new Map<string,number>()
 const segmentCongestion=(a:Point,b:Point)=>{
  const key=segmentKey(a,b),known=congestionCache.get(key)
  if(known!==undefined)return known
  let score=0
  for(const {c,d} of priorSegments){
    const horizontal=a.y===b.y,otherHorizontal=c.y===d.y
    if(horizontal===otherHorizontal){
     const separation=horizontal?Math.abs(a.y-c.y):Math.abs(a.x-c.x)
     const overlap=horizontal?Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x)):
      Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))
     if(overlap>16&&separation<4)score+=overlap*(separation<.1?12:1.5)+100
    }else{
     const h=horizontal?[a,b]:[c,d],v=horizontal?[c,d]:[a,b]
     if(v[0].x>Math.min(h[0].x,h[1].x)&&v[0].x<Math.max(h[0].x,h[1].x)&&h[0].y>Math.min(v[0].y,v[1].y)&&h[0].y<Math.max(v[0].y,v[1].y))score+=6
    }
  }
  congestionCache.set(key,score);return score
 }
 const congestion=(points:Point[])=>points.slice(1).reduce((score,p,index)=>score+segmentCongestion(points[index],p),0)
 const seen=new Set<string>()
 const options=candidates.map(simplifyRoute).filter(points=>{
  const key=points.map(p=>`${p.x},${p.y}`).join(' ')
  if(seen.has(key))return false
  seen.add(key);return clear(points)
 })
 // Fixed column gutters and the outer band guarantee an escape even for reverse control edges.
 const minimum=Math.abs(end.x-start.x)+Math.abs(end.y-start.y)
 const local=forward&&end.x-start.x<=100?options.filter(points=>length(points)<=minimum+32):[]
 const chosen=(local.length?local:options).map(points=>({points,score:length(points)+(points.length-2)*10+congestion(points)}))
  .sort((a,b)=>a.score-b.score)[0]?.points
 if(!chosen)throw new Error(`No free resource route: ${link.from} -> ${link.to}`)
 const segments=chosen.slice(1).map((end,index)=>({start:chosen[index],end,span:Math.abs(end.x-chosen[index].x)+Math.abs(end.y-chosen[index].y)}))
 const horizontal=segments.filter(segment=>segment.start.y===segment.end.y).sort((a,b)=>b.span-a.span)[0]
 const segment=horizontal||segments.sort((a,b)=>b.span-a.span)[0]
 return {points:chosen,path:chosen.map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' '),
  labelX:(segment.start.x+segment.end.x)/2,labelY:(segment.start.y+segment.end.y)/2-14}
}
