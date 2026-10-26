from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import random
from uuid import NAMESPACE_DNS, uuid5

from sqlalchemy import select, text, update

from sdm.store import events, services

BASE = datetime(2026, 1, 2, tzinfo=timezone.utc)
DECISIVE = {'Healthy', 'Degraded', 'Missing', 'Unknown'}


def receipt(index, service='sample', producer='argocd:test', uid='application',
            health='Healthy', changed_at=None, kind='argocd_notification', ref='dev', environment='test'):
    if kind == 'build':
        payload = {'source': {'ref': ref}, 'status': 'succeeded'}
        instance_id = None
    else:
        payload = {'event': 'health_changed', 'health': health, 'application_uid': uid,
                   'health_changed_at': changed_at, 'source_ref': ref, 'environment': environment}
        instance_id = f'{service}:{environment}:review' if environment == 'feature' else f'{service}:test:{service}'
    return {'id': index, 'producer': producer, 'event_id': str(uuid5(NAMESPACE_DNS, str(index))),
            'service': service, 'instance_id': instance_id, 'kind': kind, 'payload': payload,
            'fingerprint': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
            'received_at': BASE.timestamp() + 1000 + index / 10, 'applied': kind == 'build'}


def health_time(row):
    source = row['payload'].get('health_changed_at')
    if source:
        point = datetime.fromisoformat(source.replace('Z', '+00:00'))
        return int(point.timestamp()) * 1000 + point.microsecond // 1000
    return row['received_at'] * 1000


def is_health(row):
    return row['kind'] == 'argocd_notification' and row['payload'].get('event') == 'health_changed'


def context(row, all_rows):
    uid = row['payload'].get('application_uid')
    if uid is None:
        return None
    earlier = [candidate for candidate in all_rows if is_health(candidate)
               and candidate['producer'] == row['producer'] and candidate['service'] == row['service']
               and candidate['payload'].get('application_uid') == uid
               and candidate['payload'].get('health') in DECISIVE
               and (health_time(candidate), candidate['id']) < (health_time(row), row['id'])]
    return max(earlier, key=lambda candidate: (health_time(candidate), candidate['id']))['payload']['health'] if earlier else None


def test_batched_context_preserves_filters_pagination_and_immutable_receipts(store):
    store.catalog([{'key': key, 'project_id': index, 'project': f'example/{key}', 'test_ref': 'dev'}
                   for index, key in enumerate(['sample', 'other', 'retired'], 100)], 'fixture', {})
    rng = random.Random(4567)
    states = ['Healthy', 'Degraded', 'Progressing', 'Suspended', 'Missing', 'Unknown']
    rows = []
    for index in range(1, 361):
        environment = rng.choice(['test', 'feature'])
        point = BASE + timedelta(seconds=rng.randrange(90), microseconds=rng.randrange(1000) * 1000 + 123)
        rows.append(receipt(index, service=rng.choice(['sample', 'other', 'retired']),
            producer=rng.choice(['argocd:one', 'argocd:two']), uid=rng.choice(['uid-one', 'uid-two', None]),
            health=rng.choice(states), changed_at=point.isoformat() if index % 7 else None,
            kind='build' if index % 9 == 0 else 'argocd_notification', environment=environment,
            ref='feature/topic' if environment == 'feature' else 'dev'))
    with store.engine.begin() as conn:
        conn.execute(events.insert(), rows)
        conn.execute(update(services).where(services.c.key == 'retired').values(active=False))
    before = deepcopy(rows)
    cases = [dict(key='sample', limit=17), dict(key=None, limit=50),
             dict(key='other', before=240, limit=31), dict(key=None, before=180, limit=50),
             dict(key='sample', instance_id='sample:feature:review', source_ref='feature/topic', limit=50),
             dict(key='retired', limit=50), dict(key='missing', limit=50)]
    for params in cases:
        chosen = [row for row in rows if (row['service'] == params['key'] if params['key'] is not None else row['service'] != 'retired')]
        if 'instance_id' in params:
            chosen = [row for row in chosen if row['instance_id'] == params['instance_id'] or
                      row['kind'] == 'build' and row['payload']['source']['ref'] == params['source_ref']]
        if 'before' in params:
            chosen = [row for row in chosen if row['id'] < params['before']]
        expected = []
        for row in sorted(chosen, key=lambda row: row['id'], reverse=True)[:params['limit']]:
            value = deepcopy(row)
            if is_health(row):
                value['previous_health'] = context(row, rows)
            expected.append(value)
        assert store.event_history(**params) == expected
    with store.engine.connect() as conn:
        assert [dict(row) for row in conn.execute(select(events).order_by(events.c.id)).mappings()] == before


def test_contextless_pages_keep_the_original_response_shape(store):
    row = receipt(1, kind='build')
    with store.engine.begin() as conn:
        conn.execute(events.insert(), row)
    assert store.event_history('sample') == [row]
    assert store.event_history('sample', before=1) == []
    assert store.event_history('sample', limit=0) == []


def test_large_history_stays_available_at_the_standard_storage_timeout(store, client):
    size = 25000
    with store.engine.begin() as conn:
        for first in range(1, size + 1, 1000):
            conn.execute(events.insert(), [receipt(index,
                health='Healthy' if index % 2 else 'Degraded',
                changed_at=(BASE + timedelta(seconds=index)).isoformat())
                for index in range(first, min(first + 1000, size + 1))])
        conn.execute(text('ANALYZE events'))
    with store.engine.connect() as conn:
        assert conn.execute(text('SHOW statement_timeout')).scalar_one() == '5s'
    response = client.get('/api/v1/services/sample/events',
                          headers={'Authorization': 'Bearer ' + os.environ['TEST_READER']})
    assert response.status_code == 200
    page = response.json()['items']
    assert [row['id'] for row in page] == list(range(size, size - 50, -1))
    assert all(row['previous_health'] == ('Degraded' if row['payload']['health'] == 'Healthy' else 'Healthy') for row in page)
