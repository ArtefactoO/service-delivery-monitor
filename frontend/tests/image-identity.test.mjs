import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceGraph} from '../src/data.ts'

const repository = 'registry.example/shared-app'
const image = letter => ({repository, digest: 'sha256:' + letter.repeat(64)})
const workloadId = key => `k8s:sample:Deployment:sample-${key}`

function graphFor(images) {
  const keys = ['api', 'worker']
  return resourceGraph(
    {key: 'sample', project: 'team/sample', project_id: 123, test_ref: 'dev', team: null, registry_revision: 'a'.repeat(40), instances: []},
    {name: 'sample', environment: 'test', source_ref: 'dev', lifecycle: {}, observations: {test: {
      name: 'sample', namespace: 'sample', uid: 'app-uid', present: true,
      sync: 'Synced', health: 'Healthy', observed_at: '2026-10-16T12:00:00Z',
      chart_repo: 'https://git.example/team/service-chart.git', chart_ref: 'v1.0.0',
      values_ref: 'main', values_path: 'kubernetes/test/sample/values.yaml', values_revision: 'c'.repeat(40),
      resources: keys.map(key => ({kind: 'Deployment', namespace: 'sample', name: `sample-${key}`, status: 'Synced'})),
      git: {
        source_revision: 'd'.repeat(40), build_revision: 'e'.repeat(40), images,
        workloads: keys.map((key, index) => ({key, kind: 'Deployment', image: images[index], config_files: [], references: [], external_secret: {enabled: false}})),
      },
    }}},
    {gitlab: 'https://git.example', deployments: 'https://git.example/team/deployments.git', argo: {test: 'https://argo.example'}},
  )
}

test('different digests of one repository preserve each component image and its provenance edges', () => {
  const images = [image('a'), image('b')]
  const {data, relationships} = graphFor(images)
  assert.equal(Object.values(data).filter(resource => resource.role === 'image').length, 2)
  assert.equal(data[`image:${repository}`], undefined, 'an ambiguous legacy ID must not resolve to an arbitrary digest')
  for (const [index, key] of ['api', 'worker'].entries()) {
    const identity = `${repository}@${images[index].digest}`
    const id = `image:${identity}`
    assert.equal(data[id].identity, identity)
    assert.equal(data[id].fields.find(([label]) => label === 'Digest')?.[1], images[index].digest)
    assert.deepEqual(data[id].componentIds, [`component:${key}`])
    assert.ok(relationships.some(edge => edge.from === 'repo' && edge.to === id && edge.label === 'build source'))
    assert.ok(relationships.some(edge => edge.from === id && edge.to === 'values' && edge.label === 'digest'))
    const desired = relationships.filter(edge => edge.to === workloadId(key) && edge.label === 'desired image')
    assert.equal(desired.length, 1)
    assert.equal(desired[0].from, id)
  }
})

test('one shared repository and digest retains the legacy deep link and a single image resource', () => {
  const shared = image('a')
  const {data, relationships} = graphFor([shared, {...shared}])
  const id = `image:${repository}`
  assert.equal(Object.values(data).filter(resource => resource.role === 'image').length, 1)
  assert.equal(data[id].identity, `${repository}@${shared.digest}`)
  assert.deepEqual(data[id].componentIds, ['component:api', 'component:worker'])
  assert.equal(relationships.filter(edge => edge.from === 'repo' && edge.to === id && edge.label === 'build source').length, 1)
  assert.equal(relationships.filter(edge => edge.from === id && edge.to === 'values' && edge.label === 'digest').length, 1)
  assert.deepEqual(relationships.filter(edge => edge.from === id && edge.label === 'desired image').map(edge => edge.to).sort(), [workloadId('api'), workloadId('worker')])
})
