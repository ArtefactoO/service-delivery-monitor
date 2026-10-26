import type {GraphGeometry} from './graph-layout'
export const GRAPH_PADDING=100
export const MINIMAP_WIDTH=210,MINIMAP_HEIGHT=140,MINIMAP_MARGIN=20
export function nodeInViewport(node:{x:number;y:number},width:number,height:number,view:{x:number;y:number;zoom:number},canvas:{width:number;height:number}){
 const left=node.x*view.zoom+view.x,top=node.y*view.zoom+view.y,right=left+width*view.zoom,bottom=top+height*view.zoom
 return left>=6&&top>=6&&right<=canvas.width-6&&bottom<=canvas.height-6&&
  (right<=canvas.width-MINIMAP_WIDTH-MINIMAP_MARGIN||bottom<=canvas.height-MINIMAP_HEIGHT-MINIMAP_MARGIN)
}
/** The extra pan is bounded in screen pixels at every supported zoom. */
export function graphViewport(geometry:Pick<GraphGeometry,'width'|'height'>,width:number,height:number,zoom:number){
 const safeWidth=Math.max(1,width-MINIMAP_WIDTH-MINIMAP_MARGIN*2)
 const safeHeight=Math.max(1,height-MINIMAP_HEIGHT-MINIMAP_MARGIN*2)
 const minZoom=Math.max(.04,Math.min(.95,safeWidth/(geometry.width+GRAPH_PADDING*2),safeHeight/(geometry.height+GRAPH_PADDING*2)))
 const scale=Number.isFinite(zoom)&&zoom>0?Math.max(.04,zoom):.95
 const extent:[[number,number],[number,number]]=[[-GRAPH_PADDING,-GRAPH_PADDING],[geometry.width+GRAPH_PADDING+(MINIMAP_WIDTH+MINIMAP_MARGIN*2)/scale,geometry.height+GRAPH_PADDING+(MINIMAP_HEIGHT+MINIMAP_MARGIN*2)/scale]]
 const fitZoom=Math.max(minZoom,Math.min(1.1,safeWidth/(geometry.width+GRAPH_PADDING*2),safeHeight/(geometry.height+GRAPH_PADDING*2)))
 return {minZoom,extent,fit:{x:(safeWidth-geometry.width*fitZoom)/2,y:(safeHeight-geometry.height*fitZoom)/2,zoom:fitZoom}}
}
