import {gitLink,historicalSnapshot,latest,safeUrl,short,type Environment,type Instance,type Links,type Observation,type Service,type ServiceState} from './data.ts'

type Attempt=NonNullable<ServiceState['latest_attempts']>[number]['payload']
export type ImageComparison='same'|'different'|undefined

/** Compare image facts, not source SHA: a newer build may reuse identical bytes. */
export function compareAttemptImages(attempt:Attempt|undefined,observation:Observation|undefined):ImageComparison{
 const built=attempt?.images||[],published=observation?.git.images||[]
 if(!built.length||!published.length||[...built,...published].some(i=>!i.repository||!i.digest))return
 const refs=(images:typeof built)=>[...new Set(images.map(i=>`${i.repository}@${i.digest}`))].sort()
 if(JSON.stringify(refs(built))===JSON.stringify(refs(published)))return 'same'
 if(built.some(a=>published.some(b=>a.repository===b.repository&&a.digest!==b.digest)))return 'different'
}

export function ciHeaderContext(state:ServiceState,registration:Service,instance:Instance|undefined,env:Environment){
 const observation=latest(instance)?.[1],ref=instance?.source_ref||(env==='feature'?undefined:registration.test_ref)
 const attempts=state.latest_attempts||[]
 const newest=(kind:string)=>attempts.filter(({payload:p})=>p.kind===kind&&(kind==='build'?!!ref&&p.source.ref===ref:p.target?.environment===env&&(!instance||p.target.instance===instance.name)))
  .sort((a,b)=>b.payload.attempt.pipeline_id-a.payload.attempt.pipeline_id||b.payload.attempt.job_id-a.payload.attempt.job_id)[0]?.payload
 const build=newest('build')
 return {observation,ref,build,publication:newest('publication'),deployment:newest('deployment'),imageComparison:compareAttemptImages(build,observation),inactive:historicalSnapshot(instance)}
}

/** These are provenance links, never inferred CI results or reconstructed events. */
export function publicationProvenance(registration:Service,observation:Observation,links:Links){
 const source=links.gitlab?safeUrl(`${links.gitlab.replace(/\/$/,'')}/${registration.project}`):undefined
 const publisher=safeUrl(links.deployments?.replace(/\.git$/,'').replace(/\/$/,''))
 const id=(value?:string)=>value&&/^\d+$/.test(value)?value:undefined
 const git=observation.git,job=id(git.build_job),buildPipeline=id(git.build_pipeline),publication=id(git.publisher_pipeline)
 const result:{label:string;href?:string}[]=[]
 if(job)result.push({label:`Build #${job}`,href:source?`${source}/-/jobs/${job}`:undefined})
 else if(buildPipeline)result.push({label:`Build pipeline #${buildPipeline}`,href:source?`${source}/-/pipelines/${buildPipeline}`:undefined})
 else if(git.build_revision&&/^[a-f0-9]{40}$/.test(git.build_revision))result.push({label:`Build revision ${short(git.build_revision)}`,href:gitLink(source,git.build_revision)})
 if(publication)result.push({label:`Publisher pipeline #${publication}`,href:publisher?`${publisher}/-/pipelines/${publication}`:undefined})
 return result
}
