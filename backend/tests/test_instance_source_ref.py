from datetime import datetime, timezone
import json

import httpx
import pytest
from sqlalchemy import update

from sdm.config import Integration
from sdm.contracts import DeliveryEvent
from sdm.reconcile import Deferred, Reconciler
from sdm.store import Rejected, sources


def payload(make, ref, pipeline, environment='test', **kwargs):
    body = make(pipeline=pipeline, **kwargs)
    body['source']['ref'] = ref
    if environment != 'feature':
        name = 'sample-preprod' if environment == 'preprod' else 'sample'
        body['target'] = {'environment': environment, 'instance': name}
        if body.get('publication'):
            body['publication']['values_path'] = f'kubernetes/{environment}/{name}/values.yaml'
        if body.get('runtime'):
            body['runtime']['application'] = name
    return DeliveryEvent.model_validate(body)


@pytest.mark.parametrize('environment', ['test', 'prod', 'preprod'])
def test_successful_permanent_deploy_changes_current_branch_without_rewriting_history(store, settings, event, environment):
    producer = settings.producers['publisher']
    store.ingest(payload(event, 'dev', 10, environment, kind='deployment'), 'publisher', producer, {}, now=1000)
    before = store.event_history('sample')
    store.ingest(payload(event, 'release/next', 20, environment, kind='deployment'), 'publisher', producer, {}, now=1100)
    row = store.service_state('sample')['instances'][0]
    assert row['source_ref'] == 'release/next'
    assert store.catalog_state()[0]['instances'][0]['source_ref'] == 'release/next'
    assert [item for item in store.event_history('sample') if item['id'] == before[0]['id']] == before


def test_started_failed_canceled_publication_and_late_deploy_do_not_change_confirmed_branch(store, settings, event):
    producer = settings.producers['publisher']
    store.ingest(payload(event, 'confirmed', 30, kind='deployment'), 'publisher', producer, {}, now=1000)
    changes = [
        payload(event, 'pending', 40, kind='deployment', status='started'),
        payload(event, 'pending', 40, kind='deployment', status='failed', sequence=2),
        payload(event, 'canceled', 41, kind='deployment', status='canceled'),
        payload(event, 'published', 50, kind='publication'),
        payload(event, 'late', 20, kind='deployment'),
    ]
    for index, change in enumerate(changes):
        receipt = store.ingest(change, 'publisher', producer, {}, now=1100 + index)
        assert receipt['applied'] is (change.source.ref != 'late')
        assert store.service_state('sample')['instances'][0]['source_ref'] == 'confirmed'


def test_feature_branch_remains_part_of_its_instance_identity(store, settings, event):
    producer = settings.producers['publisher']
    body = event(kind='deployment', pipeline=10, feature=True)
    store.ingest(DeliveryEvent.model_validate(body), 'publisher', producer, {}, now=1000)
    changed = event(kind='deployment', pipeline=20, feature=True)
    changed['source']['ref'] = 'feature/other'
    with pytest.raises(Rejected, match='instance_identity_mismatch'):
        store.ingest(DeliveryEvent.model_validate(changed), 'publisher', producer, {}, now=1100)
    assert store.service_state('sample')['instances'][0]['source_ref'] == 'feature/topic'


def observer(store, settings, ref, now):
    settings.integrations = {
        'git': Integration(kind='gitlab', base_url='https://git.example', token_env='TEST_GITLAB', project_id=900),
        'argo': Integration(kind='argocd', base_url='https://argo.example', token_env='TEST_ARGO', projects=['services'],
            environments=['test'], deployment_repo_url='https://git.example/group/deployments.git', gitlab_source='git'),
    }
    app = {'metadata': {'name': 'sample', 'uid': '11111111-1111-4111-8111-111111111111', 'creationTimestamp': '2026-01-01T00:00:00Z'},
        'spec': {'project': 'services', 'destination': {'namespace': 'sample'}, 'sources': [
            {'repoURL': 'https://git.example/group/chart.git', 'targetRevision': 'v1.0.0', 'helm': {'valueFiles': ['$values/kubernetes/test/sample/values.yaml']}},
            {'repoURL': 'https://git.example/group/deployments.git', 'ref': 'values', 'targetRevision': 'main'}]},
        'status': {'sync': {'status': 'Synced', 'revisions': ['b' * 40, 'c' * 40]}, 'health': {'status': 'Healthy'}, 'resources': []}}
    values = {'namespace': 'sample', 'deployments': {'api': {'annotations': {
        'delivery.example.com/source-project': 'example/sample', 'delivery.example.com/source-ref': ref,
        'delivery.example.com/source-revision': 'a' * 40}}}}
    calls = []
    def handle(request):
        calls.append(request.url.host)
        if request.url.path.endswith('/repository/tree'):
            return httpx.Response(200, json=[{'type':'blob','path':'kubernetes/test/sample/values.yaml','id':'e'*40}])
        return httpx.Response(200, json={'items': [app]}) if request.url.host == 'argo.example' else httpx.Response(200, content=json.dumps(values))
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(handle)), clock=lambda: now[0], jitter=lambda *_: 0)
    with store.engine.begin() as conn:
        for name in settings.integrations:
            store.ensure_source(conn, name)
    return worker, calls


def test_validated_argo_observation_updates_permanent_branch_without_a_new_ci_event(store, settings, event, drain_checks):
    now = [datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()]
    store.ingest(payload(event, 'old', 10, kind='deployment'), 'publisher', settings.producers['publisher'], {}, now=now[0] - 300)
    before = store.event_history('sample')
    worker, calls = observer(store, settings, 'observed', now)
    try:
        worker.argo('argo')
        drain_checks(worker)
    finally:
        worker.client.close()
    row = store.service_state('sample')['instances'][0]
    assert row['source_ref'] == row['observations']['argo']['git']['source_ref'] == 'observed'
    assert store.event_history('sample') == before
    assert calls == ['argo.example', 'git.example', 'git.example']


def test_suspended_old_argo_observation_does_not_rewind_a_newer_successful_deploy_branch(store, settings, event, drain_checks):
    now = [datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()]
    producer = settings.producers['publisher']
    store.ingest(payload(event, 'old', 10, kind='deployment'), 'publisher', producer, {}, now=now[0] - 300)
    worker, calls = observer(store, settings, 'old', now)
    with store.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.name == 'git').values(backoff_until=now[0] + 600))
    try:
        from sdm.application_queue import choose, run
        worker.argo('argo')
        now[0] += 2
        run(worker, choose(worker, worker.eligible_sources()))
        now[0] += 1
        store.ingest(payload(event, 'new-confirmed', 20, kind='deployment'), 'publisher', producer, {}, now=now[0])
        before = store.event_history('sample')
        with store.engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.name == 'git').values(backoff_until=0))
        now[0] += 1
        drain_checks(worker)  # Resume the old snapshot, not a new discovery after the confirmed deploy.
    finally:
        worker.client.close()
    row = store.service_state('sample')['instances'][0]
    assert row['source_ref'] == 'new-confirmed'
    assert row['observations']['argo']['git']['source_ref'] == 'old'
    assert store.event_history('sample') == before
    assert calls == ['argo.example', 'git.example', 'git.example']
