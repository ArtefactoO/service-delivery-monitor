from copy import deepcopy
import os

import httpx
import pytest

from sdm import application_queue
from sdm import reconcile as reconcile_module
from sdm.config import Integration
from sdm.contracts import DeliveryEvent
from sdm.reconcile import Reconciler, SourceFailure
from test_late_events import absence, at, epoch, feature, receipts, row
from scale_fixtures import Inventory


NEW_UID = '22222222-2222-4222-8222-222222222222'


def application(start, observation, uid=None, created=None):
    app = {k: observation[k] for k in ['uid', 'name', 'namespace', 'project', 'values_path', 'sync', 'health', 'resources']}
    app.update(uid=uid or app['uid'], created_at=created or start['runtime']['application_created_at'],
               environment='feature', values_revision='c' * 40,
               _git={**observation['git'], 'projection_version': reconcile_module.repository_cache.PROJECTION_VERSION}, _git_revision='c' * 40)
    return app


def worker_for(store, settings, minute=15):
    settings.integrations = {'argo-test': Integration(kind='argocd', base_url='https://argo.example',
        token_env='TEST_ARGO', projects=['test-services'], environments=['feature'], runtime_enabled=True,
        deployment_repo_url='https://git.example/deployments.git')}
    def unexpected(request):
        pytest.fail('Synthetic lifecycle checks must not contact a source')
    return Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(unexpected)), clock=lambda: epoch(at(minute)))


def recreated(event, pipeline=12):
    value = event(kind='deployment', feature=True, pipeline=pipeline, uid=NEW_UID)
    value['runtime']['application_created_at'] = at(10)
    value['occurred_at'] = value['runtime']['verified_at'] = at(11)
    return value


@pytest.mark.parametrize('change', ['stop', 'recreate'])
def test_inflight_collection_cannot_change_stopped_or_replaced_snapshot(client, store, settings, headers, event, monkeypatch, change):
    start, observation = feature(client, store, headers, event)
    worker = worker_for(store, settings)
    frozen = {}
    def during_collection(*args, **kwargs):
        value = absence(event, minute=11) if change == 'stop' else recreated(event)
        assert store.ingest(DeliveryEvent.model_validate(value), 'publisher', settings.producers['publisher'],
                            settings.integrations, now=epoch(at(12)))['applied']
        frozen['row'], frozen['receipts'] = deepcopy(row(store)), receipts(store)
        return {'application_uid': start['runtime']['application_uid'], 'observed_at': at(10), 'tree': [], 'objects': []}
    monkeypatch.setattr(reconcile_module, 'collect_runtime', during_collection)
    app = {**application(start, observation), 'health': 'Degraded'}
    application_queue.enqueue_inventory(worker, 'argo-test', [app], [app], {}, epoch(at(10)))
    state = {'observed_at': at(10), 'ignored': 0, 'seen': [], '_check': {'version': 1}}
    try:
        worker.collect_application('argo-test', app, state, lambda: None)
        worker.mark_application_error('argo-test', app, 'http_503')
        assert state['ignored'] == 1 and state['seen'] == []
        assert row(store) == frozen['row']
        assert receipts(store) == frozen['receipts']
    finally:
        worker.client.close()


def test_recreated_uid_waits_for_matching_argo_and_preserves_previous_snapshot(client, store, settings, headers, event, monkeypatch):
    start, observation = feature(client, store, headers, event)
    assert client.post('/api/v1/events', json=absence(event), headers=headers).json()['applied']
    frozen = deepcopy(row(store)['observations'])
    assert client.post('/api/v1/events', json=recreated(event), headers=headers).json()['applied']
    assert row(store)['lifecycle']['application_uid'] == NEW_UID
    assert row(store)['observations'] == frozen
    summary = store.catalog_state()[0]['instances'][0]
    assert summary['present'] is None and summary['observation_uid'] == start['runtime']['application_uid']
    reader = {'Authorization': 'Bearer ' + os.environ['TEST_READER']}
    assert 'feature' not in client.get('/api/v1/services', headers=reader).json()['environments']
    assert client.get('/api/v1/services/sample/events', params={'instance': row(store)['id']}, headers=reader).json()['items']
    worker = worker_for(store, settings)
    try:
        old = application(start, observation)
        application_queue.enqueue_inventory(worker, 'argo-test', [old], [old], {}, epoch(at(12)))
        worker.mark_application_error('argo-test', old, 'http_503')
        assert row(store)['observations'] == frozen
        new = application(start, observation, NEW_UID, at(10))
        monkeypatch.setattr(reconcile_module, 'collect_runtime', lambda *args: {
            'application_uid': NEW_UID, 'observed_at': at(13), 'tree': [], 'objects': []})
        worker.collect_application('argo-test', new, {'observed_at': at(13), 'ignored': 0, 'seen': []}, lambda: None)
        assert row(store)['observations']['argo-test']['uid'] == NEW_UID
        assert store.catalog_state()[0]['instances'][0]['present'] is True
        before, saved = deepcopy(row(store)), receipts(store)
        for action in ['delete', 'upsert']:
            late = event(kind='deployment', feature=True, pipeline=20 if action == 'delete' else 21, action=action)
            late['occurred_at'] = late['runtime']['verified_at'] = at(14)
            assert client.post('/api/v1/events', json=late, headers=headers).json()['applied'] is False
        assert row(store) == before and receipts(store)[:-2] == saved
    finally:
        worker.client.close()


def test_new_argo_incarnation_can_replace_an_archive_without_ci(client, store, settings, headers, event, monkeypatch):
    start, observation = feature(client, store, headers, event)
    assert client.post('/api/v1/events', json=absence(event), headers=headers).json()['applied']
    worker = worker_for(store, settings)
    monkeypatch.setattr(reconcile_module, 'collect_runtime', lambda *args: {
        'application_uid': NEW_UID, 'observed_at': at(13), 'tree': [], 'objects': []})
    try:
        app = application(start, observation, NEW_UID, at(10))
        worker.collect_application('argo-test', app, {'observed_at': at(13), 'ignored': 0, 'seen': []}, lambda: None)
        assert row(store)['lifecycle']['application_uid'] == NEW_UID
        assert not row(store)['lifecycle'].get('stopped_at')
        assert store.catalog_state()[0]['instances'][0]['present'] is True
    finally:
        worker.client.close()


@pytest.mark.parametrize('field,value', [('uid', 'malformed-uid'), ('creationTimestamp', 'not-a-date')])
def test_invalid_inventory_identity_cannot_prove_absence_or_block_other_apps(store, settings, drain_checks, field, value):
    inventory = Inventory(store, settings, count=2)
    try:
        before = deepcopy(store.service_state('svc-000')['instances'])
        inventory.apps['argo-test'][0]['metadata'][field] = value
        inventory.worker.argo('argo-test')
        after = store.service_state('svc-000')['instances']
        previous = next(i for i in before if i['environment'] == 'test')['observations']['argo-test']
        current = next(i for i in after if i['environment'] == 'test')['observations']['argo-test']
        assert current['present'] is True
        assert current['collection_error']['code'] == 'invalid_application_data'
        assert {k: v for k, v in current.items() if k != 'collection_error'} == previous
        other = next(i for i in store.service_state('svc-001')['instances'] if i['environment'] == 'test')
        assert other['observations']['argo-test']['present'] is True
        assert other['observations']['argo-test']['presence_checked_at'] != previous['presence_checked_at']
        inventory.apps['argo-test'][0]['metadata'][field] = ('2026-01-01T00:00:00Z' if field == 'creationTimestamp' else previous['uid'])
        inventory.now[0] += 3
        inventory.worker.argo('argo-test')
        drain_checks(inventory.worker)
        recovered = next(i for i in store.service_state('svc-000')['instances'] if i['environment'] == 'test')['observations']['argo-test']
        assert recovered['present'] is True and 'collection_error' not in recovered
    finally:
        inventory.close()


def test_invalid_inventory_name_cannot_be_used_to_confirm_absence(store, settings):
    inventory = Inventory(store, settings, count=1)
    try:
        before = deepcopy(store.service_state('svc-000')['instances'])
        inventory.apps['argo-test'][0]['metadata']['name'] = 'invalid/name'
        with pytest.raises(SourceFailure, match='incomplete_application_list'):
            inventory.worker.argo('argo-test')
        assert store.service_state('svc-000')['instances'] == before
    finally:
        inventory.close()
