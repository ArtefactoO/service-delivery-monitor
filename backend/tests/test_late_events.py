from copy import deepcopy
from datetime import datetime
from itertools import permutations
import os

import httpx
import pytest
from sqlalchemy import select, update

from sdm import application_queue
from sdm.config import Integration
from sdm.reconcile import Reconciler
from sdm.store import events, instances
from test_argo_notifications import auth, notification, notifications


def at(minute, second=0):
    return f'2026-01-02T10:{minute:02}:{second:02}Z'


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def feature(client, store, headers, event, clocks=None, present=True):
    start = event(kind='deployment', feature=True, pipeline=10)
    start['occurred_at'] = start['runtime']['verified_at'] = at(0)
    assert client.post('/api/v1/events', json=start, headers=headers).status_code == 202
    observation = {'uid': start['runtime']['application_uid'], 'name': start['target']['instance'],
                   'namespace': 'sample', 'project': 'test-services', 'present': present,
                   'observed_at': at(0), 'sync': 'Synced', 'health': 'Healthy', 'resources': [],
                   'values_path': start['publication']['values_path'],
                   'git': {'project': 'example/sample', 'source_ref': start['source']['ref'],
                           'source_revision': 'a' * 40, 'namespace': 'sample', 'images': []}}
    observation.update(clocks or {})
    with store.engine.begin() as conn:
        conn.execute(update(instances).values(observations={'argo-test': observation}))
    return start, observation


def absence(event, minute=5, pipeline=11):
    stop = event(kind='deployment', feature=True, action='delete', pipeline=pipeline)
    stop.pop('runtime')
    stop['absence_confirmed'] = True
    stop['occurred_at'] = at(minute)
    return stop


def row(store):
    return store.service_state('sample', now=epoch(at(30)))['instances'][0]


def receipts(store):
    with store.engine.connect() as conn:
        return [dict(r) for r in conn.execute(select(events).order_by(events.c.id)).mappings()]


@pytest.mark.parametrize('clock', ['presence_checked_at', 'inventory_observed_at', 'observed_at'])
@pytest.mark.parametrize('minute', [5, 10])
@pytest.mark.parametrize('known_uid', [False, True])
def test_late_or_tied_absence_cannot_override_affirmative_presence(client, store, headers, event, clock, minute, known_uid):
    feature(client, store, headers, event, {clock: at(minute)})
    before, before_receipts = deepcopy(row(store)), receipts(store)
    stop = absence(event)
    if known_uid:
        stop = event(kind='deployment', feature=True, action='delete', pipeline=11)
        stop['occurred_at'] = stop['runtime']['verified_at'] = at(5)
    response = client.post('/api/v1/events', json=stop, headers=headers)
    assert response.status_code == 202 and response.json()['applied'] is False
    assert row(store) == before
    assert receipts(store)[:-1] == before_receipts
    assert receipts(store)[-1]['applied'] is False
    history = deepcopy(receipts(store))
    assert client.post('/api/v1/events', json=stop, headers=headers).json()['duplicate'] is True
    assert receipts(store) == history
    catalog = client.get('/api/v1/services', headers={'Authorization': 'Bearer ' + os.environ['TEST_READER']}).json()
    current = catalog['items'][0]['instances'][0]
    assert current['present'] is True and not current['lifecycle'].get('stopped_at')
    assert 'feature' in catalog['environments']


@pytest.mark.parametrize('known_uid', [False, True])
@pytest.mark.parametrize('clocks,present', [
    ({'presence_checked_at': at(3), 'inventory_observed_at': at(2)}, True),
    ({'presence_checked_at': at(10), 'inventory_observed_at': at(10)}, False),
    ({'observed_at': None}, True),
])
def test_newer_absence_is_still_applied_without_a_conflicting_presence(client, store, headers, event, clocks, present, known_uid):
    feature(client, store, headers, event, clocks, present)
    stop = absence(event)
    if known_uid:
        stop = event(kind='deployment', feature=True, action='delete', pipeline=11)
        stop['occurred_at'] = stop['runtime']['verified_at'] = at(5)
    response = client.post('/api/v1/events', json=stop, headers=headers)
    assert response.status_code == 202 and response.json()['applied'] is True
    assert row(store)['lifecycle']['stopped_at'] == stop['occurred_at']


def test_delete_verification_cannot_be_made_fresh_by_a_later_event_timestamp(client, store, headers, event):
    feature(client, store, headers, event, {'presence_checked_at': at(10)})
    before = deepcopy(row(store))
    stop = event(kind='deployment', feature=True, action='delete', pipeline=11)
    stop['occurred_at'], stop['runtime']['verified_at'] = at(15), at(5)
    assert client.post('/api/v1/events', json=stop, headers=headers).json()['applied'] is False
    assert row(store) == before


def test_inventory_then_delayed_absence_keeps_same_uid_collectable_and_later_real_stop_works(
        client, store, settings, headers, event):
    start, observation = feature(client, store, headers, event)
    settings.integrations = {'argo-test': Integration(kind='argocd', base_url='https://argo.example',
        token_env='TEST_ARGO', projects=['test-services'], environments=['feature'],
        deployment_repo_url='https://git.example/deployments.git')}
    def unexpected(request):
        raise AssertionError('Cached metadata test must not call upstream')
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(unexpected)), clock=lambda: epoch(at(11)))
    app = {k: observation[k] for k in ['uid', 'name', 'namespace', 'project', 'values_path', 'sync', 'health', 'resources']}
    app.update(environment='feature', created_at=start['runtime']['application_created_at'], values_revision='c' * 40)
    try:
        application_queue.enqueue_inventory(worker, 'argo-test', [app], [app], {}, epoch(at(10)))
        assert row(store)['observations']['argo-test']['presence_checked_at'].startswith(at(10)[:-1])
        stale = client.post('/api/v1/events', json=absence(event), headers=headers)
        assert stale.json()['applied'] is False
        from sdm.repository_cache import PROJECTION_VERSION
        projection = {**observation['git'], 'projection_version': PROJECTION_VERSION}
        state = {'ignored': 0, 'seen': [], 'observed_at': at(11)}
        worker.collect_application('argo-test', {**app, '_git': projection, '_git_revision': app['values_revision']}, state)
        assert state['ignored'] == 0 and state['seen'] == [row(store)['id']]
        assert row(store)['lifecycle']['application_uid'] == start['runtime']['application_uid']
        assert not row(store)['lifecycle'].get('stopped_at')
        stopped = client.post('/api/v1/events', json=absence(event, minute=12, pipeline=12), headers=headers)
        assert stopped.json()['applied'] is True
        assert row(store)['lifecycle']['stopped_at'] == at(12)
        assert [r['applied'] for r in receipts(store) if r['payload'].get('absence_confirmed')] == [False, True]
    finally:
        worker.client.close()


def health_event(notification, health, minute, version):
    return {**notification, 'health': health, 'health_changed_at': at(minute), 'resource_version': str(version)}


@pytest.mark.parametrize('order', list(permutations(range(3))))
def test_recovery_context_follows_source_time_through_progressing_in_every_delivery_order(
        notifications, notification, store, order):
    client, _ = notifications
    timeline = [health_event(notification, h, minute, 200 + minute)
                for h, minute in [('Degraded', 1), ('Progressing', 2), ('Healthy', 3)]]
    for index in order:
        assert client.post('/api/v1/argocd/events', json=timeline[index], headers=auth()).status_code == 202
    before = deepcopy(receipts(store))
    for scope in ['sample', None]:
        page = store.event_history(scope)
        assert next(r for r in page if r['payload']['health'] == 'Healthy')['previous_health'] == 'Degraded'
    assert receipts(store) == before


@pytest.mark.parametrize('reverse', [False, True])
def test_late_recovery_context_crosses_receipt_pages_and_preserves_archived_receipts(
        notifications, notification, store, reverse):
    client, _ = notifications
    timeline = [health_event(notification, 'Degraded', 1, 201), health_event(notification, 'Healthy', 2, 202)]
    for value in reversed(timeline) if reverse else timeline:
        assert client.post('/api/v1/argocd/events', json=value, headers=auth()).status_code == 202
    before, pages, cursor = deepcopy(receipts(store)), [], None
    for _ in range(2):
        params = {'limit': 1, **({'before': cursor} if cursor else {})}
        response = client.get('/api/v1/services/sample/events', params=params,
                              headers={'Authorization': 'Bearer ' + os.environ['TEST_READER']})
        assert response.status_code == 200
        page = response.json()['items']
        assert len(page) == 1
        pages += page
        cursor = page[0]['id']
    healthy = next(r for r in pages if r['payload']['health'] == 'Healthy')
    assert healthy['previous_health'] == 'Degraded'
    assert receipts(store) == before
    future = health_event(notification, 'Unknown', 4, 204)
    assert client.post('/api/v1/argocd/events', json=future, headers=auth()).status_code == 202
    assert next(r for r in store.event_history('sample') if r['id'] == healthy['id']) == healthy
    assert receipts(store)[:-1] == before


def test_health_time_uses_frontend_milliseconds_timezone_and_receipt_id_ties(notifications, notification, store):
    client, _ = notifications
    healthy = {**health_event(notification, 'Healthy', 1, 202), 'health_changed_at': '2026-01-02T10:01:00.123900Z'}
    degraded = {**health_event(notification, 'Degraded', 1, 201), 'health_changed_at': '2026-01-02T12:01:00.123100+02:00'}
    for payload in [healthy, degraded]:
        assert client.post('/api/v1/argocd/events', json=payload, headers=auth()).status_code == 202
    rows = store.event_history('sample')
    assert next(r for r in rows if r['payload']['health'] == 'Healthy')['previous_health'] is None
    assert next(r for r in rows if r['payload']['health'] == 'Degraded')['previous_health'] == 'Healthy'


def test_missing_source_time_falls_back_to_receipt_time_and_other_uids_stay_isolated(
        notifications, notification, store, monkeypatch):
    client, _ = notifications
    now = [epoch(at(1))]
    monkeypatch.setattr('sdm.argo_notifications.time.time', lambda: now[0])
    degraded = {**health_event(notification, 'Degraded', 1, 201), 'health_changed_at': None}
    assert client.post('/api/v1/argocd/events', json=degraded, headers=auth()).status_code == 202
    now[0] = epoch(at(3))
    healthy = health_event(notification, 'Healthy', 2, 202)
    assert client.post('/api/v1/argocd/events', json=healthy, headers=auth()).status_code == 202
    other = {**healthy, 'application_uid': '22222222-2222-4222-8222-222222222222'}
    assert client.post('/api/v1/argocd/events', json=other, headers=auth()).status_code == 202
    rows = store.event_history('sample')
    assert next(r for r in rows if r['payload']['health'] == 'Healthy' and r['payload']['application_uid'] == notification['application_uid'])['previous_health'] == 'Degraded'
    assert next(r for r in rows if r['payload']['application_uid'] == other['application_uid'])['previous_health'] is None
