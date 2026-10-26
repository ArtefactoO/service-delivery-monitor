type Dependency={from:string;to:string}

/** Keep familiar columns where possible, with providers before their consumers.
 * Cycles share a column; their true edge directions are never reversed or dropped. */
export function dependencyColumns(preferred:ReadonlyMap<string,number>,edges:readonly Dependency[]){
 const ids=[...preferred.keys()].sort(),out=new Map(ids.map(id=>[id,new Set<string>()])),incoming=new Map(ids.map(id=>[id,new Set<string>()]))
 for(const {from,to}of edges)if(out.has(from)&&out.has(to)){out.get(from)!.add(to);incoming.get(to)!.add(from)}
 // Condense strongly connected resources before assigning finite DAG bounds.
 const seen=new Set<string>(),finished:string[]=[]
 for(const id of ids){
  const stack:{id:string;finish:boolean}[]=[{id,finish:false}]
  while(stack.length){
   const item=stack.pop()!
   if(item.finish){finished.push(item.id);continue}
   if(seen.has(item.id))continue
   seen.add(item.id);stack.push({id:item.id,finish:true})
   for(const next of [...out.get(item.id)!].sort().reverse())if(!seen.has(next))stack.push({id:next,finish:false})
  }
 }
 const groups:string[][]=[],owner=new Map<string,number>()
 for(const id of finished.reverse()){
  if(owner.has(id))continue
  const group:string[]=[],stack=[id],index=groups.length
  while(stack.length){const next=stack.pop()!;if(owner.has(next))continue;owner.set(next,index);group.push(next);stack.push(...incoming.get(next)!)}
  groups.push(group.sort())
 }
 const children=groups.map(()=>new Set<number>()),parents=groups.map(()=>new Set<number>())
 for(const [from,targets]of out)for(const to of targets){const a=owner.get(from)!,b=owner.get(to)!;if(a!==b){children[a].add(b);parents[b].add(a)}}
 const degree=parents.map(p=>p.size),ready=groups.map((_,i)=>i).filter(i=>!degree[i]),order:number[]=[],earliest=groups.map(()=>0)
 while(ready.length){
  ready.sort((a,b)=>groups[b][0].localeCompare(groups[a][0]))
  const index=ready.pop()!;order.push(index)
  for(const child of children[index]){earliest[child]=Math.max(earliest[child],earliest[index]+1);if(!--degree[child])ready.push(child)}
 }
 const span=Math.max(0,...preferred.values(),...earliest),latest=groups.map(()=>span),columns=groups.map(()=>0)
 for(const index of [...order].reverse())for(const child of children[index])latest[index]=Math.min(latest[index],latest[child]-1)
 for(const index of order){
  const desired=Math.round(groups[index].reduce((sum,id)=>sum+preferred.get(id)!,0)/groups[index].length)
  const minimum=Math.max(0,...[...parents[index]].map(parent=>columns[parent]+1))
  columns[index]=Math.max(minimum,Math.min(desired,latest[index]))
 }
 return new Map(ids.map(id=>[id,columns[owner.get(id)!]]))
}
