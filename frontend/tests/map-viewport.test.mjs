import test from 'node:test'
import assert from 'node:assert/strict'
import {graphViewport,GRAPH_PADDING,MINIMAP_WIDTH,MINIMAP_HEIGHT,MINIMAP_MARGIN} from '../src/graph-viewport.ts'
import {layoutResourceGraph,GRAPH_NODE_WIDTH,GRAPH_NODE_HEIGHT} from '../src/graph-layout.ts'
import {boxesOverlap} from '../src/graph-labels.ts'

const geometry={width:2800,height:2200}
test('last corner can be panned beyond the minimap at readable, fit and maximum zoom',()=>{
 for(const zoom of [.95,.12,1.8]){
  const policy=graphViewport(geometry,1040,720,zoom),right=policy.extent[1][0]-geometry.width,bottom=policy.extent[1][1]-geometry.height
  assert.ok(right*zoom>=MINIMAP_WIDTH+MINIMAP_MARGIN*2)
  assert.ok(bottom*zoom>=MINIMAP_HEIGHT+MINIMAP_MARGIN*2)
  assert.ok(right*zoom<=MINIMAP_WIDTH+MINIMAP_MARGIN*2+GRAPH_PADDING*zoom+.01)
  assert.ok(bottom*zoom<=MINIMAP_HEIGHT+MINIMAP_MARGIN*2+GRAPH_PADDING*zoom+.01)
 }
})
test('fit view uses a minimap-free rectangle without changing graph coordinates',()=>{
 const before=structuredClone(geometry),policy=graphViewport(geometry,1040,720,.95),view=policy.fit
 assert.ok(view.x>=0&&view.y>=0)
 assert.ok(view.x+geometry.width*view.zoom<1040-MINIMAP_WIDTH-MINIMAP_MARGIN)
 assert.ok(view.y+geometry.height*view.zoom<720-MINIMAP_HEIGHT-MINIMAP_MARGIN)
 assert.deepEqual(geometry,before)
 assert.deepEqual(graphViewport(geometry,1040,720,.95),policy)
})
const roles=[['image','image'],['vault','vault'],['config','configmap'],['eso','eso'],['secret','secret'],['account','resource','ServiceAccount'],['job','workload','Job'],['pod','pod']]
const resources=[{id:'repo',role:'repo',kind:'Source code'},...roles.map(([id,role,kind])=>({id,role,kind:kind||role,componentIds:['component:migrator']}))]
const links=[['repo','image','build source','source'],['image','job','desired image','artifact'],['image','pod','runs','artifact'],['config','job','mount','configuration'],['vault','eso','extract','secret'],['eso','secret','target','secret'],['secret','job','envFrom','secret'],['account','job','service account','configuration'],['account','pod','service account','configuration'],['job','pod','owns','control']].map(([from,to,label,family])=>({from,to,label,family}))
test('complete edge label boxes avoid every card, including the adjacent source and target',()=>{
 const graph=layoutResourceGraph(resources,links,[{id:'component:migrator',key:'migrator'}])
 for(const edge of graph.edges){
  const label={x:edge.labelX-edge.labelWidth/2,y:edge.labelY-edge.labelHeight/2,width:edge.labelWidth,height:edge.labelHeight}
  for(const node of graph.nodes)assert.equal(boxesOverlap(label,{...node,width:GRAPH_NODE_WIDTH,height:GRAPH_NODE_HEIGHT}),false,`${edge.id} caption overlaps ${node.id}`)
 }
 const refresh=layoutResourceGraph(resources.map(item=>({...item,status:{label:'New',tone:'warn'},subtitle:'new hash'})),links,[{id:'component:migrator',key:'migrator'}])
 assert.deepEqual(refresh,graph)
})
