import type {Tone} from './data'

/** Health and Sync are observations from Argo, never derived from replica counts. */
export function argoResourceStatus(sync?:string,health?:string):{label:string;tone:Tone}{
 const tone:Tone=health==='Degraded'||health==='Missing'?'danger':sync==='OutOfSync'||health==='Progressing'?'warn':health==='Healthy'?'ok':'muted'
 return {label:sync==='OutOfSync'&&health?`${sync} · ${health}`:health||sync||'Unknown',tone}
}
