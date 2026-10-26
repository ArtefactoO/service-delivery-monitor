import { siArgo, siGitlab, siHelm, siKubernetes, siSonatype, siVault } from 'simple-icons'
import {Box} from 'lucide-react'

const systems = {
  gitlab: { label: 'GitLab', icon: siGitlab },
  argocd: { label: 'Argo CD', icon: siArgo },
  helm: { label: 'Helm', icon: siHelm },
  kubernetes: { label: 'Kubernetes', icon: siKubernetes },
  vault: { label: 'Vault', icon: siVault },
  nexus: { label: 'Nexus', icon: siSonatype },
  registry: { label: 'Container registry', icon: null },
} as const

export type SystemId = keyof typeof systems

export function systemName(system: SystemId) {
  return systems[system].label
}

export function SystemIcon({ system, size = 14 }: { system: SystemId; size?: number }) {
  const icon=systems[system].icon
  if(!icon)return <Box className="system-icon" data-system={system} size={size} aria-hidden="true"/>
  return <svg className="system-icon" data-system={system} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d={icon.path}/></svg>
}

export function SystemBadge({ system, iconOnly = false, size = 14 }: { system: SystemId; iconOnly?: boolean; size?: number }) {
  return <span className={`system-badge${iconOnly ? ' system-badge-icon-only' : ''}`} data-system={system} title={systems[system].label} aria-label={iconOnly ? systems[system].label : undefined}><SystemIcon system={system} size={size}/>{!iconOnly && <span>{systems[system].label}</span>}</span>
}
