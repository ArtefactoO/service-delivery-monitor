import type {ResourceRole} from './data'

export const graphNodeCategories = {
  source: {label:'Sources',color:'var(--graph-category-source)'},
  artifact: {label:'Artifacts',color:'var(--graph-category-artifact)'},
  control: {label:'Control',color:'var(--graph-category-control)'},
  runtime: {label:'Kubernetes',color:'var(--graph-category-runtime)'},
  secret: {label:'Secrets',color:'var(--graph-category-secret)'},
} as const

type GraphNodeCategory = keyof typeof graphNodeCategories

const categoryByRole = {
  repo:'source',sourceValues:'source',config:'source',chart:'source',
  image:'artifact',values:'artifact',argo:'control',
  workload:'runtime',replicaSet:'runtime',pod:'runtime',configmap:'runtime',resource:'runtime',
  vault:'secret',eso:'secret',secret:'secret',
} satisfies Record<ResourceRole,GraphNodeCategory>

export const graphNodeCategory = (role:ResourceRole):GraphNodeCategory => categoryByRole[role]
