import type { EdgeFamily } from './edge-semantics'
import type { SystemId } from './SystemBadge'
import {enrichRuntime,type RuntimeSnapshot,type RuntimeSummary} from './runtime-data.ts'
import {assignComponentMembership, componentId} from './components.ts'
import {enrichNetwork} from './network-data.ts'
import {argoResourceStatus} from './argo-status.ts'
import type {FreshnessInfo} from './freshness-policy'
export type Environment = 'test' | 'preprod' | 'prod' | 'feature'
export type Tone = 'ok' | 'warn' | 'danger' | 'muted'
export type ResourceId = string
export type ResourceRole = 'repo' | 'sourceValues' | 'config' | 'vault' | 'image' | 'values' | 'chart' | 'argo' | 'workload' | 'eso' | 'secret' | 'configmap' | 'resource' | 'pod' | 'replicaSet'
export interface Resource { id: string; role: ResourceRole; title: string; kind: string; system: SystemId; identity: string; apiGroup?:string; description: string; fields: [string, string][]; fieldLinks?:Partial<Record<string,string>>; linkLabel: string; url?: string; subtitle?: string; status?: {label: string; tone: Tone}; freshness?:FreshnessInfo; componentIds?: string[]; endpoints?: {url:string;label:string}[] }
export type RelationshipEvidence='published-values'|'kubernetes-spec'|'argo-inventory'|'argo-tree'|'publication-metadata'|'application-sources'
export interface Relationship { from: string; to: string; label: string; family: EdgeFamily; evidence?:RelationshipEvidence; componentIds?: string[]; context?: boolean }
export interface Image { repository: string; digest: string }
export interface Life { created_at?: string; stopped_at?: string; auto_stop_at?: string; application_uid?: string }
export interface DeliveryVersions { ci?:{project:string;ref:string;revision:string}|null; release?:{tag:string;version:string;operation:string;revision:string}|null; version_errors?:{ci?:string;release?:string}|null }
export interface InstanceSummary extends DeliveryVersions { id: string; name: string; environment: Environment; source_ref: string; lifecycle: Life; source?:string; observation_uid?:string; sync?: string; health?: string; present?: boolean; observed_at?: string; inventory_observed_at?: string|null; check_interval_seconds?:number|null; chart_repo?: string|null; chart_ref?: string; values_ref?: string; source_revision?: string; images: Image[]; runtime?: RuntimeSummary }
export interface Service { key: string; project: string; project_id: number; test_ref: string | null; team: string | null; registry_revision: string; instances: InstanceSummary[] }
export interface Workload { key: string; name?: string; kind: string; image?: Image; desired_replicas?: number; config_files: string[]; config_mounts: {mountPath?: string; subPath?: string}[]; config_mount_path?: string; references: {kind: string; name: string; relation: string}[]; external_secret: {enabled: boolean; env_from: boolean; store: {name?: string; kind?: string}; remote_refs: {key: string; property?: string; mode?:'property'|'value'|'extract'}[]} }
export interface Observation { runtime?: RuntimeSnapshot; name: string; namespace: string; project: string; uid: string; present: boolean; sync: string; health: string; observed_at: string; inventory_observed_at?:string; presence_checked_at?:string; collection_error?:{code:string;checked_at:string}; check_interval_seconds?:number; chart_repo: string; chart_ref: string; release_name?: string; values_ref: string; values_path: string; values_revision: string; resources: {group?: string; kind: string; namespace: string; name: string; status?: string; health?: string}[]; git: DeliveryVersions & {source_revision: string; build_revision?: string; source_ref: string; images: Image[]; config_revision?: string; config_project?: string; config_dir?: string; config_ref?: string; config_managed_files?:string[]; build_job?: string; build_pipeline?: string; publisher_pipeline?: string; workloads?: Workload[]} }
export interface Instance { id: string; name: string; environment: Environment; source_ref: string; lifecycle: Life; observations: Record<string, Observation>; lifetime_seconds: number | null; expires_in_seconds: number | null; stop_overdue: boolean; desired?: unknown; verified?: unknown }
export interface ServiceState { service: Service; instances: Instance[]; generated_at: string; latest_attempts?: {key:string;received_at:number;payload:DeliveryPayload & {kind:string}}[] }
export interface Links { gitlab: string | null; argo: Record<string, string>; argo_check_intervals?:Record<string,number>; deployments: string | null; vault_stores?: Record<string, {url: string; mount: string}> }
export interface Source { name: string; kind: string; interval_seconds: number | null; last_success_at: number | null; last_attempt_at: number | null; error_code: string | null; failures: number; window_count?:number;window_start?:number;next_request_at?:number;backoff_until?:number;requests_per_window?:number|null;window_seconds?:number|null;min_request_interval_seconds?:number|null;timeout_seconds?:number|null;tracked_applications?:number|null;pending_applications?:number|null;oldest_pending_at?:number|null;last_application_success_at?:number|null;resource_interval_seconds?:number|null;application_error_count?:number;application_errors?:{application:string;code:string}[];last_application_error?:{application:string;code:string;checked_at:number}|null }
export interface DeliveryPayload {status: string; occurred_at: string; source: {ref: string; revision: string}; target?: {environment: string; instance: string}; images?:Image[]; failure_code?: string; attempt: {project_id?:number;pipeline_id: number; job_id: number;sequence?:number};action?:string;publication?:{revision:string};runtime?:{application_uid:string;verified_at?:string}}
export interface ArgoNotificationPayload {event: string; source: string; project: string; application: string; application_uid: string; resource_version: string; environment: string; source_project: string; source_ref: string; sync: string; health: string; revisions: string[];operation_started_at?:string;operation_finished_at?:string;health_changed_at?:string;application_created_at?:string;deletion_started_at?:string}
export interface EventRecord { id: number; service: string; kind: string; applied: boolean; received_at: number; previous_health?:string|null; payload: DeliveryPayload | ArgoNotificationPayload }
export const short = (value?: string | null, n = 12) => value ? value.replace(/^sha256:/, '').slice(0, n) : 'Неизвестно'
export const age = (seconds?: number | null) => seconds == null ? 'Неизвестно' : seconds < 60 ? `${Math.max(0, Math.floor(seconds))}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`
export const since = (date?: string | number | null) => date ? age(Date.now() / 1000 - (typeof date === 'number' ? date : Date.parse(date) / 1000)) + ' назад' : 'Наблюдений пока нет'
export function tone(value?: string): Tone { return value === 'Healthy' || value === 'succeeded' ? 'ok' : value === 'Degraded' || value === 'Missing' || value === 'failed' ? 'danger' : value === 'Progressing' || value === 'OutOfSync' || value === 'started' ? 'warn' : 'muted' }
export function argoTone(sync?:string,health?:string):Tone { return health==='Degraded'||health==='Missing'?'danger':sync==='OutOfSync'||health==='Progressing'?'warn':sync==='Synced'&&health==='Healthy'?'ok':'muted' }
export const argoCheckedAt=(observation?:{inventory_observed_at?:string|null;observed_at?:string|null})=>observation?.inventory_observed_at||observation?.observed_at||undefined
export function observationMatchesLifecycle(lifecycle:Life|undefined,uid?:string) { return !lifecycle?.application_uid || lifecycle.application_uid===uid }
export function latest(instance?: Instance) {
  return Object.entries(instance?.observations || {}).sort((a, b) =>
    Number(observationMatchesLifecycle(instance!.lifecycle,b[1].uid))-Number(observationMatchesLifecycle(instance!.lifecycle,a[1].uid)) ||
    b[1].observed_at.localeCompare(a[1].observed_at))[0]
}
export function historicalSnapshot(instance?:Instance) {
  const observation=latest(instance)?.[1]
  return !!instance&&(!!instance.lifecycle?.stopped_at||observation?.present===false||
    !!observation&&!observationMatchesLifecycle(instance.lifecycle,observation.uid))
}
export function safeUrl(value?: string | null) { if (!value) return undefined; try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined } catch { return undefined } }
const repoUrl = (value?: string | null) => safeUrl(value?.replace(/\.git$/, ''))
const path = (value: string) => value.split('/').map(encodeURIComponent).join('/')
export function gitLink(base: string | undefined, revision?: string | null, file?: string, directory = false) { return base ? safeUrl(revision ? `${base}/-/${file && !directory ? 'blob' : 'tree'}/${encodeURIComponent(revision)}${file ? '/' + path(file) : ''}` : base) : undefined }
export function chartVersionUrl(repository?:string|null,revision?:string|null){return revision?gitLink(repoUrl(repository),revision):undefined}
export function registryUrl(links: Links, revision?: string) { return gitLink(repoUrl(links.deployments), revision || 'main', 'ci/publish.py') }
export const edgeId = (edge: Relationship) => `${edge.from}|${edge.label}|${edge.to}`

const nativeGroups:Record<string,string>={Pod:'',Secret:'',ConfigMap:'',Service:'',ServiceAccount:'',PersistentVolumeClaim:'',PersistentVolume:'',Namespace:'',Deployment:'apps',StatefulSet:'apps',DaemonSet:'apps',ReplicaSet:'apps',Job:'batch',CronJob:'batch',Ingress:'networking.k8s.io',ExternalSecret:'external-secrets.io'}
const rawKind=(kind:string)=>kind==='Kubernetes Secret'?'Secret':kind
export function kubernetesGroup(kind:string,group?:string|null){return group??nativeGroups[rawKind(kind)]??''}
export function kubernetesIdentity(kind:string,name:string,namespace:string,group?:string|null){return `${kubernetesGroup(kind,group)||'~core'}/${namespace||'_cluster'}/${rawKind(kind)}/${name}`}
export type KubernetesIdResolver=(kind:string,name:string,namespace:string,group?:string|null)=>string

/** Preserve unambiguous deep links; API groups must never share a resource node. */
export function kubernetesResourceIds(data:Record<string,Resource>,runtime?:RuntimeSnapshot,inventory:{kind:string;name:string;namespace:string;group?:string|null}[]=[]):KubernetesIdResolver{
  const groups=new Map<string,Set<string>>()
  const key=(kind:string,name:string,namespace:string)=>`k8s:${namespace}:${rawKind(kind)}:${name}`
  const register=(kind:string,name:string,namespace:string,group?:string|null)=>{
    const base=key(kind,name,namespace),known=groups.get(base)||new Set<string>()
    known.add(kubernetesGroup(kind,group))
    // Native spec references always address their canonical API group.
    if(rawKind(kind) in nativeGroups)known.add(nativeGroups[rawKind(kind)])
    groups.set(base,known)
  }
  for(const resource of Object.values(data))if(resource.id.startsWith('k8s:')&&resource.kind&&resource.title){
    const namespace=resource.fields.find(([label])=>label==='Namespace')?.[1]||resource.id.split(':')[1]
    register(resource.kind,resource.title,namespace==='Cluster-scoped'?'':namespace,resource.apiGroup)
  }
  for(const resource of [...inventory,...(runtime?.tree||[]),...(runtime?.objects||[])])register(resource.kind,resource.name,resource.namespace,resource.group)
  return(kind,name,namespace,group)=>{
    const base=key(kind,name,namespace),apiGroup=kubernetesGroup(kind,group)
    return (groups.get(base)?.size||0)>1?`${base}@${apiGroup||'~core'}`:base
  }
}

export function resourceGraph(service: Service, instance: Instance | undefined, links: Links) {
  const data: Record<string, Resource> = {}, relationships: Relationship[] = []
  const entry = latest(instance), obs = entry?.[1], git = obs?.git
  const sourceRepo = repoUrl(links.gitlab ? `${links.gitlab}/${service.project}` : null)
  const argoBase = entry ? safeUrl(links.argo[entry[0]])?.replace(/\/$/, '') : undefined
  const argoUrl = argoBase && obs ? `${argoBase}/applications/argocd/${encodeURIComponent(obs.name)}` : undefined
  const deploymentRepo = repoUrl(links.deployments)
  const checkInterval=obs?.check_interval_seconds||(entry?links.argo_check_intervals?.[entry[0]]:undefined)
  const freshness:FreshnessInfo={checkedAt:obs?.observed_at,intervalSeconds:checkInterval,inactive:historicalSnapshot(instance)}
  const add = (resource: Resource) => { data[resource.id] = resource; return resource.id }
  const edge = (from: string, to: string, label: string, family: EdgeFamily,evidence:RelationshipEvidence='published-values') => { if (data[from] && data[to] && !relationships.some(r => r.from === from && r.to === to && r.label === label)) relationships.push({from, to, label, family,evidence}) }
  const fields = (pairs: [string, unknown][]): [string, string][] => pairs.filter(([,v]) => v !== undefined && v !== null && v !== '').map(([k,v]) => [k, String(v)])
  add({id: 'repo', role: 'repo', kind: 'Source code', title: service.key, system: 'gitlab', identity: service.project,
    description: 'Исходный репозиторий. Build revision берется из provenance опубликованного image; результат CI показывается отдельно в истории событий.',
    subtitle: instance?.source_ref || service.test_ref || service.project,
    fields: fields([['Repository', service.project], ['Project ID', service.project_id], ['Build revision', git?.build_revision], ['Build pipeline',git?.build_pipeline], ['Branch', instance?.source_ref || service.test_ref], ['Team', service.team || 'Не назначена']]),
    fieldLinks:{Repository:sourceRepo,Branch:gitLink(sourceRepo,instance?.source_ref||service.test_ref), 'Build revision':gitLink(sourceRepo,git?.build_revision),'Build pipeline':sourceRepo&&git?.build_pipeline&&/^\d+$/.test(git.build_pipeline)?`${sourceRepo}/-/pipelines/${git.build_pipeline}`:undefined},
    url: gitLink(sourceRepo, git?.build_revision), linkLabel: 'Открыть исходники'})
  if(git?.ci){
    const ciRepo=repoUrl(links.gitlab?`${links.gitlab}/${git.ci.project}`:undefined)
    data.repo.fields.push(['CI/CD ref',git.ci.ref],['CI/CD project',git.ci.project],['CI/CD source revision',git.ci.revision])
    data.repo.fieldLinks={...data.repo.fieldLinks,'CI/CD ref':gitLink(ciRepo,git.ci.ref),'CI/CD project':ciRepo,'CI/CD source revision':gitLink(sourceRepo,git.ci.revision,'.gitlab-ci.yml')}
  }
  if(git?.release&&instance?.environment==='prod'){
    data.repo.fields.push(['Release tag',git.release.tag],['Release version',git.release.version],['Release operation',git.release.operation])
    const releaseUrl=safeUrl(sourceRepo?`${sourceRepo}/-/tags/${encodeURIComponent(git.release.tag)}`:undefined)
    data.repo.fieldLinks={...data.repo.fieldLinks,'Release tag':releaseUrl,'Release version':releaseUrl}
  }
  if(git?.version_errors?.ci)data.repo.fields.push(['CI/CD discovery',git.version_errors.ci])
  if(git?.version_errors?.release)data.repo.fields.push(['Release discovery',git.version_errors.release])
  if (!obs || !instance) return {data, relationships, observation: obs}
  add({id: 'sourceValues', role: 'sourceValues', kind: 'Source values', system: 'gitlab', title: `deploy/values-${instance.environment}.yaml`,
    identity: `${service.project}@${git!.source_revision}`, description: 'Входные values из revision, записанной publisher. Пути соответствуют контракту service delivery.', subtitle: short(git!.source_revision),
    fields: fields([['Revision', git!.source_revision], ['Branch',instance.source_ref], ['Common path', 'deploy/values.yaml'], ['Environment path', `deploy/values-${instance.environment}.yaml`]]),
    fieldLinks:{Revision:gitLink(sourceRepo,git!.source_revision),Branch:gitLink(sourceRepo,instance.source_ref),'Common path':gitLink(sourceRepo,git!.source_revision,'deploy/values.yaml'),'Environment path':gitLink(sourceRepo,git!.source_revision,`deploy/values-${instance.environment}.yaml`)},
    url: gitLink(sourceRepo, git!.source_revision, 'deploy', true), linkLabel: 'Открыть каталог deploy'})
  add({id: 'values', role: 'values', kind: 'Generated values', system: 'gitlab', title: 'values.yaml', identity: obs.values_path,
    description: 'Generated values на revision, которую наблюдает Argo. Sync status показывает, совпадает ли желаемое состояние с кластером.', subtitle: short(obs.values_revision),
    fields: fields([['Path', obs.values_path], ['Revision', obs.values_revision], ['Branch', obs.values_ref], ['Publisher pipeline', git!.publisher_pipeline]]),fieldLinks:{Path:gitLink(deploymentRepo,obs.values_revision,obs.values_path),Revision:gitLink(deploymentRepo,obs.values_revision),Branch:gitLink(deploymentRepo,obs.values_ref),'Publisher pipeline':deploymentRepo&&/^\d+$/.test(git!.publisher_pipeline||'')?`${deploymentRepo}/-/pipelines/${git!.publisher_pipeline}`:undefined}, url: gitLink(deploymentRepo, obs.values_revision, obs.values_path), linkLabel: 'Открыть generated values'})
  add({id: 'argo', role: 'argo', kind: 'Argo Application', system: 'argocd', title: obs.name, identity: obs.uid,
    description: 'Наблюдение Argo CD. Health и Sync не подменяют результаты build/deploy jobs.', subtitle: `branch ${obs.values_ref || '?'} · chart ${obs.chart_ref || '?'}`,
    fieldLinks:{'Values branch':gitLink(deploymentRepo,obs.values_ref)},
    status: {label: `${obs.sync} · ${obs.health}`, tone: argoTone(obs.sync,obs.health)}, freshness:{...freshness,checkedAt:argoCheckedAt(obs)}, fields: fields([['Sync', obs.sync], ['Health', obs.health], ['Values branch', obs.values_ref], ['Chart ref', obs.chart_ref], ['Namespace', obs.namespace], ['Project', obs.project], ['Application UID', obs.uid], ['Observed at', argoCheckedAt(obs)]]), url: argoUrl, linkLabel: 'Открыть Argo Application'})
  edge('sourceValues', 'values', 'merge', 'configuration','publication-metadata'); edge('values', 'argo', 'Git source', 'control','application-sources')
  if (obs.chart_repo) {
    add({id: 'chart', role: 'chart', kind: 'Helm chart', system: 'gitlab', title: obs.chart_repo.replace(/\.git$/, '').split('/').pop() || 'Helm chart', identity: obs.chart_repo,
      subtitle: obs.chart_ref, description: 'Отдельный chart repository и ref из Application.', fields: fields([['Repository', obs.chart_repo], ['Chart ref', obs.chart_ref]]),fieldLinks:{Repository:repoUrl(obs.chart_repo),'Chart ref':chartVersionUrl(obs.chart_repo,obs.chart_ref)}, url: chartVersionUrl(obs.chart_repo,obs.chart_ref)||repoUrl(obs.chart_repo), linkLabel: 'Открыть chart'})
    edge('chart', 'argo', 'chart source', 'configuration','application-sources')
  }
  if (git?.config_revision) {
    const base = repoUrl(git.config_project && links.gitlab ? `${links.gitlab}/${git.config_project}` : null)
    if (git.config_managed_files?.length) {
      add({id: 'config', role: 'config', kind: 'Application config', system: 'gitlab', title: git.config_project?.split('/').pop() || 'Config revision', identity: git.config_revision,
        description: 'Источник импортированных файлов из metadata publisher. Содержимое файлов монитор не хранит.', subtitle: short(git.config_revision), fields: fields([['Repository', git.config_project], ['Directory', git.config_dir], ['Revision', git.config_revision], ['Branch', git.config_ref]]),
        fieldLinks:{Repository:base,Branch:gitLink(base,git.config_ref),Revision:gitLink(base,git.config_revision),Directory:gitLink(base,git.config_revision,git.config_dir,true)},url: gitLink(base, git.config_revision, git.config_dir, true), linkLabel: 'Открыть конфигурацию'})
      edge('config', 'values', 'config files', 'configuration','publication-metadata')
    } else {
      // Discovery records its revision even when no files were imported. A legacy
      // receipt without the file list also cannot establish a config dependency.
      data.values.fields.push(...fields([['Config discovery', git.config_managed_files ? 'Файлы не импортированы' : 'Импорт файлов не подтвержден'], ['Config repository', git.config_project], ['Config revision', git.config_revision], ['Config branch', git.config_ref], ['Checked config directory', git.config_dir]]))
      data.values.fieldLinks={...data.values.fieldLinks,'Config repository':base,'Config revision':gitLink(base,git.config_revision),'Config branch':gitLink(base,git.config_ref)}
    }
  }
  const imageIds = new Map<string, string>()
  const repositoryDigests = new Map<string, Set<string>>()
  for (const image of git?.images || []) {
    if (!repositoryDigests.has(image.repository)) repositoryDigests.set(image.repository, new Set())
    repositoryDigests.get(image.repository)!.add(image.digest)
  }
  for (const image of git?.images || []) {
    const identity = `${image.repository}@${image.digest}`
    if (imageIds.has(identity)) continue
    const nodeId = repositoryDigests.get(image.repository)!.size > 1 ? `image:${identity}` : `image:${image.repository}`
    const parts=image.repository.split('/'),host=parts[0],qualified=/[.:]/.test(host)||host==='localhost'
    const id = add({id: nodeId, role: 'image', kind: 'Container image', system: host==='registry.example.com'?'nexus':'registry', title: (qualified?parts.slice(1).join('/'):image.repository)||image.repository, identity,
      description: 'Image digest из generated values. Наличие digest само по себе не подтверждает успешность последней CI job или использование всеми Pods.', subtitle: short(image.digest), fields: fields([['Repository', image.repository], ['Digest', image.digest], ['Build revision', git?.build_revision], ["Build job", git?.build_job],["Build pipeline",git?.build_pipeline]]),
      url: sourceRepo && git?.build_job && /^\d+$/.test(git.build_job) ? `${sourceRepo}/-/jobs/${git.build_job}` : undefined, linkLabel: 'Открыть build job'})
    imageIds.set(identity, id)
    data[id].fieldLinks={'Build job':data[id].url,'Build revision':gitLink(sourceRepo,git?.build_revision),'Build pipeline':sourceRepo&&git?.build_pipeline&&/^\d+$/.test(git.build_pipeline)?`${sourceRepo}/-/pipelines/${git.build_pipeline}`:undefined}
    if (git?.build_revision) edge('repo', id, 'build source', 'source','publication-metadata')
    edge(id, 'values', 'digest', 'artifact','publication-metadata')
  }
  const resourceId = kubernetesResourceIds(data,obs.runtime,obs.resources.map(resource=>({...resource,namespace:resource.namespace??obs.namespace})))
  const k8s = (kind: string, name: string, declared = false, namespace = obs.namespace, group?:string|null) => {
    const apiGroup=kubernetesGroup(kind,group),id = resourceId(kind, name, namespace,apiGroup)
    if (data[id]) return id
    const found = obs.resources.find(r => r.kind === kind && r.name === name && (r.namespace ?? obs.namespace) === namespace&&kubernetesGroup(r.kind,r.group)===apiGroup)
    const native=apiGroup===kubernetesGroup(kind)
    const role: ResourceRole = !native?'resource':['Deployment', 'Job', 'StatefulSet', 'DaemonSet'].includes(kind) ? 'workload' : kind === 'ConfigMap' ? 'configmap' : kind === 'ExternalSecret' ? 'eso' : kind === 'Secret' ? 'secret' : 'resource'
    add({id, role, kind: kind === 'Secret'&&native ? 'Kubernetes Secret' : kind, system: 'kubernetes', title: name, identity: kubernetesIdentity(kind,name,namespace,apiGroup),apiGroup,
      description: found ? 'Sync и Health получены из Argo. Метрики runtime показаны отдельно и не меняют статус ресурса.' : kind==='Secret' ? 'Ссылка на Secret из конфигурации. Статус связанного ExternalSecret показан отдельно; собственный статус Secret в Argo не получен. Значения секретов монитор не читает.' : 'Ссылка из published values. Собственный статус ресурса в Argo не получен.',
      subtitle: namespace || 'Cluster-scoped', status: found ? argoResourceStatus(found.status,found.health) : {label:declared?'Declared':'Referenced',tone:'muted'}, freshness:found?{...freshness,checkedAt:argoCheckedAt(obs)}:undefined,
      fields: fields([['Namespace', namespace || 'Cluster-scoped'],['API group',apiGroup||'core'], ['Sync', found?.status], ['Health', found?.health], ['Evidence', found ? 'Argo inventory' : 'Published values reference']]), url: argoUrl ? argoUrl + '?view=tree' : undefined, linkLabel: 'Открыть дерево Argo'})
    if (found) edge('argo', id, 'manages', 'control','argo-inventory')
    return id
  }
  for (const r of obs.resources) k8s(r.kind, r.name, false, r.namespace ?? obs.namespace,r.group)
  const sharedChart = /\/service-chart(?:\.git)?$/.test(obs.chart_repo || '')
  const vaultProperties=new Map<string,Set<string>>()
  const storeIdentities=new Map<string,Set<string>>()
  const storeIdentity=(store:Workload['external_secret']['store'])=>`${store.kind||'ClusterSecretStore'}:${store.kind==='SecretStore'?obs.namespace:'_cluster'}:${store.name||'Unknown store'}`
  for(const workload of git?.workloads||[]){
    if(!workload.external_secret.enabled)continue
    const store=workload.external_secret.store,name=store.name||'Unknown store',known=storeIdentities.get(name)||new Set<string>()
    known.add(storeIdentity(store));storeIdentities.set(name,known)
  }
  const matches=(sharedChart?git?.workloads||[]:[]).map(workload=>{
    const base=workload.name||`${obs.release_name||obs.name}-${workload.key}`
    const candidates=obs.resources.filter(r=>r.kind===workload.kind&&kubernetesGroup(r.kind,r.group)===kubernetesGroup(workload.kind)&&(r.namespace??obs.namespace)===obs.namespace&&
      (r.name===base||workload.kind==='Job'&&r.name.startsWith(base+'-')&&/^[a-f0-9]{12}$/.test(r.name.slice(base.length+1))))
    return{workload,candidates}
  })
  for (const {workload,candidates} of matches) {
    // Both directions must be unique, including an explicit name colliding with a hashed Job.
    if (candidates.length !== 1 || matches.filter(match=>match.candidates.includes(candidates[0])).length!==1) continue
    const name = candidates[0].name, id = k8s(workload.kind, name)
    data[id].componentIds = [componentId(workload.key)]
    data[id].fields.push(...fields([['Published replicas', workload.desired_replicas], ['Image digest', workload.image?.digest]]))
    const image = workload.image && imageIds.get(`${workload.image.repository}@${workload.image.digest}`)
    if (image) edge(image, id, 'desired image', 'artifact')
    if (workload.config_files.length) {
      const config = k8s('ConfigMap', name + '-config', true)
      data[config].fields.push(['Files', workload.config_files.join(', ')])
      const mounts=(workload.config_mounts||[]).filter(mount=>mount.mountPath).map(mount=>`${mount.subPath||workload.config_files.join(', ')} → ${mount.mountPath}`)
      if(!mounts.length&&workload.config_mount_path)mounts.push(`${workload.config_files.join(', ')} → ${workload.config_mount_path}`)
      if(mounts.length)data[config].fields.push(['Published mounts',mounts.join('\n')])
      const configRepo=repoUrl(git?.config_project&&links.gitlab?`${links.gitlab}/${git.config_project}`:undefined)
      for(const file of workload.config_files){
        const field='File: '+file
        data[config].fields.push([field,file])
        if(git?.config_managed_files?.includes(file)&&git.config_dir&&git.config_revision){
          data[config].fieldLinks={...data[config].fieldLinks,[field]:gitLink(configRepo,git.config_revision,`${git.config_dir}/${file}`)}
        }
      }
      edge('values', config, 'config data', 'configuration'); edge(config, id, 'mount', 'configuration')
    }
    const eso = workload.external_secret
    if (eso.enabled) {
      const ext = k8s('ExternalSecret', name + '-runtime', true), sec = k8s('Secret', name + '-runtime', true)
      const store=eso.store.name||'Unknown store',kind=eso.store.kind||'ClusterSecretStore',identity=storeIdentity(eso.store)
      const legacy=kind==='ClusterSecretStore'&&storeIdentities.get(store)?.size===1
      const binding=links.vault_stores?.[identity]||(legacy?links.vault_stores?.[store]:undefined)
      data[ext].fields.push(['SecretStore',store],['Store kind',kind])
      edge(ext, sec, 'target', 'secret')
      if (eso.env_from) edge(sec, id, 'envFrom', 'secret')
      for (const ref of eso.remote_refs) {
        const vault = legacy?`vault:${store}:${ref.key}`:`vault:${identity}:${ref.key}`
        const vaultUrl = binding && safeUrl(binding.url) ? `${binding.url.replace(/\/$/, '')}/ui/vault/secrets/${encodeURIComponent(binding.mount)}/kv/${encodeURIComponent(ref.key)}/details` : undefined
        if (!data[vault]) add({id: vault, role: 'vault', kind: 'Vault reference', system: 'vault', title: ref.key, identity: `${identity}/${ref.key}`, description: 'Путь Vault из remoteRef или dataFrom.extract ExternalSecret. Значения секретов монитор не читает. Mount берется из настроенного SecretStore binding.', subtitle: store,
          fields: fields([['SecretStore', store],['Store kind',kind],['Store namespace',kind==='SecretStore'?obs.namespace:undefined], ['Mount', binding?.mount], ['Remote key', ref.key]]), url: vaultUrl, linkLabel: 'Открыть Vault'})
        const properties=vaultProperties.get(vault)||new Set<string>()
        properties.add(ref.property|| (ref.mode==='extract'?'All properties (extract)':ref.mode==='value'?'Whole value':'Не указано'))
        vaultProperties.set(vault,properties)
        data[vault].fields=data[vault].fields.filter(([key])=>key!=='Properties')
        data[vault].fields.push(['Properties',[...properties].sort().join('\n')])
        edge(vault, ext, ref.mode==='extract'?'extract':'remoteRef', 'secret')
      }
    }
    for (const ref of workload.references) edge(k8s(ref.kind, ref.name), id, ref.relation, ref.kind === 'Secret' ? 'secret' : 'configuration')
  }
  enrichRuntime(data,relationships,obs.runtime,argoUrl,checkInterval,resourceId)
  for(const relation of relationships.filter(edge=>edge.label==='target'&&data[edge.from]?.role==='eso'&&data[edge.to]?.role==='secret')){
    const ext=data[relation.from],sec=data[relation.to],health=ext.fields.find(([key])=>key==='Health')?.[1]
    sec.fields.push(['ExternalSecret',ext.title],['ESO Health',health||'Неизвестно'])
  }
  enrichNetwork(data,relationships,obs.runtime,argoUrl,resourceId)
  assignComponentMembership(data,relationships)
  if(historicalSnapshot(instance)){
    for(const resource of Object.values(data))if(resource.system==='kubernetes'||resource.role==='argo'){
      resource.status={label:'Last snapshot',tone:'muted'}
      if(resource.freshness)resource.freshness={...resource.freshness,inactive:true}
      resource.description=(!observationMatchesLifecycle(instance.lifecycle,obs.uid)
        ?'Показан снимок предыдущего Application. Новый UID еще не подтвержден сверкой Argo. '
        :'Application остановлен или отсутствует в последней сверке. Показан последний известный снимок. ')+resource.description
    }
  }
  return {data, relationships, observation: obs}
}
