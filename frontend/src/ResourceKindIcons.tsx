import { siHelm } from 'simple-icons'

const esoIcon = new URL('./assets/eso-icon.svg', import.meta.url).href

export function HelmIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" data-kind-icon="helm"><path d={siHelm.path}/></svg>
}

export function ExternalSecretsIcon({ size = 16 }: { size?: number }) {
  return <span data-kind-icon="eso" aria-hidden="true" style={{ display: 'inline-block', flex: 'none', width: size, height: size, backgroundColor: 'currentColor', mask: `url("${esoIcon}") center / contain no-repeat`, WebkitMask: `url("${esoIcon}") center / contain no-repeat` }}/>
}
