import type { Relationship, Resource } from './data'

export interface ServiceComponent {
  id: string
  key: string
  workloads: Resource[]
  resources: Resource[]
}

const commonRoles = new Set(['repo', 'sourceValues', 'config', 'values', 'chart', 'argo'])
export const componentId = (key: string) => `component:${key}`
export const isCommonResource = (resource: Resource) => commonRoles.has(resource.role)

/** Only explicit chart membership and verified owner edges establish component membership. */
export function assignComponentMembership(data: Record<string, Resource>, relationships: Relationship[]) {
  const merge = (resource: Resource, ids: readonly string[]) => {
    if (isCommonResource(resource) || !ids.length) return false
    const next = [...new Set([...(resource.componentIds || []), ...ids])].sort()
    if (next.join('\0') === (resource.componentIds || []).join('\0')) return false
    resource.componentIds = next
    return true
  }
  let changed = true
  while (changed) {
    changed = false
    for (const edge of relationships) {
      const source = data[edge.from], target = data[edge.to]
      if (!source || !target) continue
      // Runtime owns edges use controller UID ancestry, never name-prefix matching.
      if (edge.label === 'owns') changed = merge(target, source.componentIds || []) || changed
      else if (edge.family !== 'control') changed = merge(source, target.componentIds || []) || changed
    }
  }
  for (const edge of relationships) {
    const from = data[edge.from]?.componentIds || [], to = data[edge.to]?.componentIds || []
    const intersection = from.filter(id => to.includes(id))
    const ids = intersection.length ? intersection : [...new Set([...from, ...to])]
    if (ids.length) edge.componentIds = ids.sort()
    else if (!isCommonResource(data[edge.from]) || !isCommonResource(data[edge.to])) edge.componentIds = []
    if (isCommonResource(data[edge.from]) || isCommonResource(data[edge.to])) edge.context = true
  }
}

/** The overview and resource map consume the same component inventory. */
export function buildComponents(data: Record<string, Resource>) {
  const resources = Object.values(data)
  const ids = [...new Set(resources.flatMap(resource => resource.role === 'workload' ? resource.componentIds || [] : []))]
  const components: ServiceComponent[] = ids.map(id => ({
    id,
    key: id.slice('component:'.length),
    workloads: resources.filter(resource => resource.role === 'workload' && resource.componentIds?.includes(id)),
    resources: resources.filter(resource => resource.componentIds?.includes(id)),
  }))
  return {
    components,
    shared: resources.filter(resource => isCommonResource(resource) || (resource.componentIds?.length || 0) > 1),
    unassigned: resources.filter(resource => !isCommonResource(resource) && !resource.componentIds?.length),
  }
}
