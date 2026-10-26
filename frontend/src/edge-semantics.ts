export const edgeFamilies = {
  source: { label: 'Source code', color: 'var(--edge-source)', dash: undefined },
  artifact: { label: 'Image / digest', color: 'var(--edge-artifact)', dash: '3 3' },
  configuration: { label: 'Configuration', color: 'var(--edge-configuration)', dash: '6 4' },
  secret: { label: 'Secrets', color: 'var(--edge-secret)', dash: '1 5' },
  control: { label: 'Control', color: 'var(--edge-control)', dash: '10 5' },
} as const

export type EdgeFamily = keyof typeof edgeFamilies

export function edgeColor(_family: EdgeFamily, active: boolean, dimmed: boolean) {
  return active && !dimmed ? 'var(--graph-active-path)' : 'var(--edge-neutral)'
}
