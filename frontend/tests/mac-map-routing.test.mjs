import test from 'node:test'
import assert from 'node:assert/strict'
import {routeLink,simplifyRoute} from '../src/graph-routing.ts'
import {placeEdgeLabels} from '../src/graph-labels.ts'

const points=path=>[...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m=>({x:+m[1],y:+m[2]}))
const length=path=>path.slice(1).reduce((sum,p,i)=>sum+Math.abs(p.x-path[i].x)+Math.abs(p.y-path[i].y),0)
const crosses=(a,b,box)=>a.y===b.y?a.y>box.y&&a.y<box.y+box.height&&Math.min(a.x,b.x)<box.x+box.width&&Math.max(a.x,b.x)>box.x:a.x>box.x&&a.x<box.x+box.width&&Math.min(a.y,b.y)<box.y+box.height&&Math.max(a.y,b.y)>box.y

test('an unrelated caption cannot cover a dependency that may become selected',()=>{
 const edges=[{id:'mount',from:'config',to:'pod',path:'M 0 100 L 300 100',labelX:150,labelY:86},
  {id:'pull',from:'registry',to:'pod',path:'M 150 0 L 150 200',labelX:150,labelY:50}]
 const graph=placeEdgeLabels(edges,[],[],new Map([['mount','service account'],['pull','image pull secret']]),224,116)
 for(const edge of graph){
  const box={x:edge.labelX-edge.labelWidth/2,y:edge.labelY-edge.labelHeight/2,width:edge.labelWidth,height:edge.labelHeight}
  for(const other of edges.filter(other=>other.id!==edge.id)){
   const line=points(other.path)
   assert.ok(!line.slice(1).some((p,i)=>crosses(line[i],p,box)),`${edge.id} masks ${other.id}`)
  }
 }
 assert.deepEqual(placeEdgeLabels(edges.map(e=>({...e,selected:true})),[],[],new Map([['mount','service account'],['pull','image pull secret']]),224,116).map(({selected,...edge})=>edge),graph)
})

test('different relationship types do not merge into the same long corridor',()=>{
 const start={x:224,y:58},end={x:800,y:58},boxes=[{id:'source',x:0,y:0,width:224,height:116},{id:'target',x:800,y:0,width:224,height:116}]
 const previous=[{from:'argo',to:'target',label:'manages',points:[start,end]}]
 const route=routeLink({from:'source',to:'target',label:'selects'},start,end,boxes,[-20,140],previous)
 for(let i=1;i<route.points.length;i++){
  const a=route.points[i-1],b=route.points[i]
  if(a.y===58&&b.y===58)assert.ok(Math.min(Math.max(a.x,b.x),800)-Math.max(Math.min(a.x,b.x),224)<=16)
 }
 assert.equal(route.points[0],start)
 assert.equal(route.points.at(-1),end)
})

test('a local obstacle uses its own bypass instead of looping around the whole row',()=>{
 const start={x:224,y:58},end={x:1100,y:58},boxes=[
  {id:'source',x:0,y:0,width:224,height:116},{id:'target',x:1100,y:0,width:224,height:116},
  {id:'lower',x:400,y:20,width:224,height:116},{id:'upper',x:760,y:-72,width:224,height:116}]
 const route=routeLink({from:'source',to:'target',label:'desired image'},start,end,boxes,[-24,200])
 assert.ok(length(route.points)<=end.x-start.x+84,route.path)
 for(let i=1;i<route.points.length;i++)for(const box of boxes)assert.equal(crosses(route.points[i-1],route.points[i],box),false,`route cuts ${box.id}`)
})

test('route simplification preserves a reversal instead of hiding traveled distance',()=>{
 const input=[{x:0,y:0},{x:20,y:0},{x:10,y:0},{x:10,y:20}]
 assert.deepEqual(simplifyRoute(input),input)
})
