import copy
import base64
from datetime import datetime, timezone
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import event as sql_events, inspect, select, update

from sdm.config import Integration
from sdm.contracts import DeliveryEvent
from sdm.reconcile import Reconciler, SourceFailure
from sdm.store import Rejected, attempt_index, health_index, events, instances, jobs, sources

NOW = datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()


def test_archived_attempt_cannot_acquire_a_conflicting_terminal_result(store, settings, event):
    producer = settings.producers['publisher']
    original = event(pipeline=10)
    store.ingest(DeliveryEvent.model_validate(original), 'publisher', producer, {}, now=NOW)
    store.ingest(DeliveryEvent.model_validate(event(pipeline=20)), 'publisher', producer, {}, now=NOW + 1)
    before = store.event_history('sample')
    conflict = event(pipeline=10, status='failed')
    with pytest.raises(Rejected, match='terminal_attempt_conflict'):
        store.ingest(DeliveryEvent.model_validate(conflict), 'publisher', producer, {}, now=NOW + 2)
    assert store.event_history('sample') == before
    conflicting_metadata = copy.deepcopy(original)
    conflicting_metadata['event_id'] = str(uuid4())
    conflicting_metadata['publication']['revision'] = 'e' * 40
    with pytest.raises(Rejected, match='event_order_conflict'):
        store.ingest(DeliveryEvent.model_validate(conflicting_metadata), 'publisher', producer, {}, now=NOW + 3)
    late = event(pipeline=5)
    assert not store.ingest(DeliveryEvent.model_validate(late), 'publisher', producer, {}, now=NOW + 4)['applied']


def test_initialize_adds_indexes_to_existing_schema_without_rewriting_history(store, settings, event):
    store.ingest(DeliveryEvent.model_validate(event()), 'publisher', settings.producers['publisher'], {}, now=NOW)
    before = store.event_history('sample')
    with store.engine.begin() as conn:
        attempt_index.drop(conn)
        health_index.drop(conn)
    store.initialize()
    store.initialize()
    installed = {index['name'] for index in inspect(store.engine).get_indexes('events')}
    assert {attempt_index.name, health_index.name}.issubset(installed)
    assert store.ready() and store.event_history('sample') == before


def test_first_feature_stop_preserves_uid_age_and_rejects_resurrection(store, settings, event):
    producer = settings.producers['publisher']
    stop = event(kind='deployment', feature=True, action='delete')
    store.ingest(DeliveryEvent.model_validate(stop), 'publisher', producer, {}, now=NOW)
    archived = store.service_state('sample')['instances'][0]
    assert archived['lifecycle']['application_uid'] == stop['runtime']['application_uid']
    assert archived['lifetime_seconds'] == 86400
    assert archived['lifecycle']['first_verified_at'] is None
    late = event(kind='deployment', feature=True, pipeline=20)
    assert not store.ingest(DeliveryEvent.model_validate(late), 'publisher', producer, {}, now=NOW + 1)['applied']
    assert store.service_state('sample')['instances'][0]['lifecycle'] == archived['lifecycle']


def test_invalid_feature_ref_is_a_validation_error(client, headers, event):
    body = event(status='started', feature=True)
    body['source']['ref'] = 'main'
    assert client.post('/api/v1/events', headers=headers, json=body).status_code == 422


def application(name='sample'):
    return {'metadata': {'name': name, 'uid': '11111111-1111-4111-8111-111111111111',
        'creationTimestamp': '2026-01-01T00:00:00Z'}, 'spec': {'project': 'services',
        'destination': {'namespace': name}, 'sources': [
            {'repoURL': 'https://git.example/chart.git', 'targetRevision': 'v1',
             'helm': {'valueFiles': [f'$values/kubernetes/test/{name}/values.yaml']}},
            {'repoURL': 'https://git.example/deployments.git', 'targetRevision': 'main', 'ref': 'values'}]},
        'status': {'sync': {'status': 'Synced', 'revisions': ['b' * 40, 'c' * 40]},
                   'health': {'status': 'Healthy'}, 'resources': []}}


def observer(store, settings, apps):
    settings.integrations = {
        'argo': Integration(kind='argocd', base_url='https://argo.example', token_env='TEST_ARGO',
            projects=['services'], environments=['test'], deployment_repo_url='https://git.example/deployments.git',
            gitlab_source='git', runtime_enabled=False),
        'git': Integration(kind='gitlab', base_url='https://git.example', token_env='TEST_GITLAB', project_id=900),
    }
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
                        clock=lambda: NOW, jitter=lambda *_: 0)
    worker.bootstrap()
    def get(name, path, **kwargs):
        if path == '/api/v1/applications':
            return json.dumps({'items': apps}).encode(), None
        if path.endswith('/repository/tree'):
            return json.dumps([{'type':'blob','path':f"kubernetes/test/{app['metadata']['name']}/values.yaml",
                                'id':('d' if app['metadata']['name']=='broken' else 'e')*40} for app in apps]).encode(), None
        if 'broken' in path:
            return b'{}', None
        values = {'namespace': 'sample', 'deployments': {'api': {'annotations': {
            'delivery.example.com/source-project': 'example/sample', 'delivery.example.com/source-ref': 'dev',
            'delivery.example.com/source-revision': 'a' * 40}}}}
        return json.dumps(values).encode(), None
    worker.get = get
    return worker


def test_present_application_with_unresolved_revision_is_not_absent(store, settings, drain_checks):
    apps = [application()]
    worker = observer(store, settings, apps)
    try:
        worker.argo('argo')
        drain_checks(worker)
        before = store.service_state('sample')['instances'][0]['observations']['argo']
        apps[0]['status']['sync'].pop('revisions')
        worker.argo('argo')
        observation = store.service_state('sample')['instances'][0]['observations']['argo']
        assert observation['present'] is True
        assert observation['git'] == before['git']
        assert observation['observed_at'] == before['observed_at']
        assert observation['collection_error']['code'] == 'unresolved_values_revision'
    finally:
        worker.client.close()


def test_bad_application_does_not_starve_the_next_application(store, settings, drain_checks):
    worker = observer(store, settings, [application('broken'), application()])
    try:
        worker.argo('argo')
        drain_checks(worker)
        assert store.service_state('sample')['instances'][0]['observations']['argo']['present'] is True
        from sdm.application_queue import stats
        state = stats(store, NOW)['argo']
        assert state['tracked_applications'] == 2 and state['error_names'] == ['broken']
        assert state['application_error_count'] == 1
    finally:
        worker.client.close()


@pytest.mark.parametrize('code', ['connection_failed', 'http_501', 'http_503'])
def test_origin_failures_keep_source_backoff_instead_of_marking_partial_success(store, settings, code, drain_checks):
    worker = observer(store, settings, [application()])
    original = worker.get
    def fail(name, path, **kwargs):
        if path != '/api/v1/applications':
            raise SourceFailure(code)
        return original(name, path, **kwargs)
    worker.get = fail
    with store.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.name == 'git').values(due_at=NOW + 10000))
    try:
        assert worker.tick()
        drain_checks(worker)
        state = worker.source_state('argo')
        assert state['error_code'] == code and state['failures'] == 1
        assert state['backoff_until'] > NOW and state['last_success_at'] == NOW  # Inventory succeeded; the later read did not.
    finally:
        worker.client.close()


def test_ci_upsert_never_overwrites_a_concurrent_absence_sweep(store, settings, event, drain_checks):
    apps = [application()]
    worker = observer(store, settings, apps)
    worker.argo('argo')
    drain_checks(worker)
    apps.clear()
    reached = []
    def interleave(conn, cursor, statement, parameters, context, executemany):
        if not reached and statement.startswith('INSERT INTO instances'):
            reached.append(True)
            worker.argo('argo')
            assert store.service_state('sample')['instances'][0]['observations']['argo']['present'] is False
    sql_events.listen(store.engine, 'before_cursor_execute', interleave)
    try:
        store.ingest(DeliveryEvent.model_validate(event(status='started')), 'publisher', settings.producers['publisher'], {}, now=NOW + 1)
        assert reached
        assert store.service_state('sample')['instances'][0]['observations']['argo']['present'] is False
    finally:
        sql_events.remove(store.engine, 'before_cursor_execute', interleave)
        worker.client.close()


def test_retired_job_does_not_block_active_sources_or_reset_budget(store, settings):
    settings.integrations = {'current': Integration(kind='gitlab', base_url='https://git.example', token_env='TEST_GITLAB', project_id=900)}
    now = [NOW]
    worker = Reconciler(store, settings, clock=lambda: now[0], jitter=lambda *_: 0)
    worker.bootstrap()
    with store.engine.begin() as conn:
        conn.execute(jobs.insert().values(name='retired', due_at=0, generation=0))
        conn.execute(update(sources).where(sources.c.name == 'current').values(window_count=29, backoff_until=NOW + 60))
    called = []
    worker.registry = lambda name: called.append(name)
    try:
        assert not worker.tick()  # An active backoff must still be respected.
        now[0] += 60
        assert worker.tick() and called == ['current']
        assert worker.source_state('current')['window_count'] == 29
    finally:
        worker.client.close()


def test_team_changes_apply_on_unchanged_registry_including_removal(store, settings):
    settings.integrations = {'git': Integration(kind='gitlab', base_url='https://git.example', token_env='TEST_GITLAB', project_id=900)}
    settings.teams = {'sample': 'old'}
    worker = Reconciler(store, settings, clock=lambda: NOW, jitter=lambda *_: 0)
    worker.bootstrap()
    content = "SERVICES = {'sample': {'project_id': 100, 'project': 'example/sample'}}"
    first = [True]
    def get(name, path, **kwargs):
        if path.endswith('/repository/tree'):
            return b'[]', None
        if not first[0]:
            return None, 'unchanged'
        first[0] = False
        return json.dumps({'content': base64.b64encode(content.encode()).decode(), 'last_commit_id': 'a' * 40}).encode(), 'unchanged'
    worker.get = get
    try:
        worker.registry('git')
        assert store.list_services()[0]['team'] == 'old'
        settings.teams = {'sample': 'new'}
        worker.registry('git')
        assert store.list_services()[0]['team'] == 'new'
        settings.teams = {}
        worker.registry('git')
        assert store.list_services()[0]['team'] is None
    finally:
        worker.client.close()


def test_history_recovery_context_crosses_pages_without_mutating_receipts(store):
    def append(health):
        payload = {'event': 'health_changed', 'health': health, 'application_uid': 'same-uid'}
        with store.engine.begin() as conn:
            return conn.execute(events.insert().values(producer='argocd:test', event_id=str(uuid4()), service='sample',
                kind='argocd_notification', payload=payload, fingerprint='f' * 64, received_at=NOW, applied=False)
                .returning(events.c.id)).scalar_one()
    append('Degraded')
    healthy = append('Healthy')
    first = store.event_history('sample', limit=1)[0]
    assert first['id'] == healthy and first['previous_health'] == 'Degraded'
    append('Unknown')  # A later receipt cannot reclassify the archived Healthy entry.
    assert store.event_history('sample', before=healthy + 1, limit=1)[0] == first
    with store.engine.connect() as conn:
        assert conn.execute(select(events.c.payload).where(events.c.id == healthy)).scalar_one() == first['payload']
