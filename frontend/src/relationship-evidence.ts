import type {Relationship} from './data'

const labels={
 'published-values':'Published values',
 'kubernetes-spec':'Kubernetes spec',
 'argo-inventory':'Argo inventory',
 'argo-tree':'Argo owner UID',
 'publication-metadata':'Publication metadata',
 'application-sources':'Application sources',
}
export function relationshipEvidence(edge:Pick<Relationship,'evidence'>){
 return edge.evidence?labels[edge.evidence]:'Source not recorded'
}

/** Explain the exact reference without implying delivery of Secret data to an app. */
export function relationshipDetail(edge:Pick<Relationship,'evidence'|'label'>){
 if(edge.evidence!=='kubernetes-spec')return undefined
 switch(edge.label){
  case 'TLS secret':return 'Ingress spec.tls[].secretName: сертификат для TLS на Ingress.'
  case 'image pull secret':return 'Pod spec.imagePullSecrets[].name: учетные данные для скачивания image, не env приложения.'
  case 'routes to':return 'Ingress spec.rules[].http.paths[].backend.service: маршрут к Service.'
  case 'default backend':return 'Ingress spec.defaultBackend.service: Service для запросов без подходящего маршрута.'
  case 'selects':return 'Service spec.selector совпадает с фактическими labels Pod. Готовность EndpointSlice отдельно не проверена.'
  case 'matches template':return 'Service spec.selector совпадает с labels шаблона контроллера. Это не подтверждение выбора всех его Pods.'
  case 'service account':return 'spec.serviceAccountName: учетная запись Pod или шаблона контроллера.'
  case 'envFrom':return 'spec.containers/initContainers[].envFrom: переменные окружения из указанного ресурса.'
  case 'env':return 'spec.containers/initContainers[].env[].valueFrom: отдельные переменные из указанного ресурса.'
  case 'mount':return 'spec.volumes: ресурс подключен как volume.'
  case 'projected mount':return 'spec.volumes[].projected.sources: ресурс включен в projected volume.'
 }
}
