import { historicalSnapshot, latest, observationMatchesLifecycle, type Environment, type Instance, type InstanceSummary, type Tone } from './data.ts'

/** An event or registration alone is not evidence of an existing Application. */
export function isPresent(instance: Instance | InstanceSummary): boolean {
  if (instance.lifecycle?.stopped_at) return false
  const observation = 'observations' in instance ? latest(instance)?.[1] : undefined
  const present = 'observations' in instance ? observation?.present : instance.present
  const uid = 'observations' in instance ? observation?.uid : instance.observation_uid
  return present === true && observationMatchesLifecycle(instance.lifecycle,uid)
}

export function presentInstances<T extends Instance | InstanceSummary>(instances: T[], environment: Environment): T[] {
  return instances.filter(item => item.environment === environment && isPresent(item))
    .sort((a, b) => a.source_ref.localeCompare(b.source_ref) || a.name.localeCompare(b.name))
}

export function presentEnvironments(instances: readonly (Instance | InstanceSummary)[], order: readonly Environment[] = []): Environment[] {
  const present = new Set(instances.filter(isPresent).map(item => item.environment))
  return [...new Set([...order, ...[...present].sort()])].filter(environment => present.has(environment))
}

export function archivedFeatures<T extends Instance | InstanceSummary>(instances: T[]): T[] {
  return instances.filter(item => item.environment === 'feature' && ('observations' in item ? historicalSnapshot(item) :
    item.lifecycle?.stopped_at || item.present === false ||
    !!item.observation_uid&&!observationMatchesLifecycle(item.lifecycle,item.observation_uid)))
    .sort((a,b) => a.source_ref.localeCompare(b.source_ref) || a.name.localeCompare(b.name))
}

export function aggregateHealth(instances: InstanceSummary[]): {label: string; tone: Tone} {
  if (!instances.length) return {label: 'Нет окружения', tone: 'muted'}
  if (instances.some(item => item.health === 'Degraded' || item.health === 'Missing')) return {label: 'Есть проблемы', tone: 'danger'}
  if (instances.some(item => item.health === 'Progressing' || item.sync === 'OutOfSync')) return {label: 'Есть изменения', tone: 'warn'}
  if (instances.every(item => item.health === 'Healthy' && item.sync === 'Synced')) return {label: 'Healthy', tone: 'ok'}
  return {label: 'Есть неизвестные статусы', tone: 'muted'}
}
