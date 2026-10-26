import os

import pytest
from sqlalchemy import update

from sdm.contracts import DeliveryEvent
from sdm.store import instances


@pytest.mark.parametrize('inventory_at', ['2026-10-19T11:59:00Z', None])
@pytest.mark.parametrize('archived', [False, True])
def test_catalog_keeps_inventory_and_runtime_times_distinct_without_rewriting_snapshots(
        store, settings, event, client, inventory_at, archived):
    store.ingest(DeliveryEvent.model_validate(event(kind='deployment')), 'publisher',
                 settings.producers['publisher'], {}, now=1000)
    old = '2026-10-19T10:00:00Z'
    observation = {'name': 'sample', 'sync': 'Synced', 'health': 'Degraded',
                   'present': not archived, 'observed_at': old,
                   'runtime': {'observed_at': old, 'objects': [], 'tree': []}}
    if inventory_at:
        observation['inventory_observed_at'] = inventory_at
    with store.engine.begin() as conn:
        conn.execute(update(instances).values(observations={'argo-test': observation}))
    before = store.service_state('sample')['instances'][0]['observations']
    receipts = store.event_history('sample')
    response = client.get('/api/v1/services', headers={
        'Authorization': 'Bearer ' + os.environ['TEST_READER']})
    assert response.status_code == 200
    row = response.json()['items'][0]['instances'][0]
    assert row['inventory_observed_at'] == inventory_at
    assert row['observed_at'] == old
    assert row['runtime']['observed_at'] == old
    assert row['health'] == 'Degraded'
    assert store.service_state('sample')['instances'][0]['observations'] == before
    assert store.event_history('sample') == receipts


def test_catalog_chart_repository_and_ref_follow_matching_uid_without_rewriting_history(store, settings, event, client):
    value=event(kind='deployment')
    store.ingest(DeliveryEvent.model_validate(value),'publisher',settings.producers['publisher'],{},now=1000)
    matching={'uid':value['runtime']['application_uid'],'present':True,'observed_at':'2026-10-19T10:00:00Z',
              'chart_repo':'https://git.example/shared/chart.git','chart_ref':'v1.2.3'}
    stale={**matching,'uid':'22222222-2222-4222-8222-222222222222','observed_at':'2026-10-20T10:00:00Z',
           'chart_repo':'https://git.example/other/chart.git','chart_ref':'v9.9.9'}
    with store.engine.begin() as conn:
        conn.execute(update(instances).values(observations={'matching':matching,'stale':stale}))
    before=store.service_state('sample')['instances'][0]['observations']
    history=store.event_history('sample')
    response=client.get('/api/v1/services',headers={'Authorization':'Bearer '+os.environ['TEST_READER']})
    assert response.status_code==200
    summary=response.json()['items'][0]['instances'][0]
    assert summary['chart_repo']==matching['chart_repo'] and summary['chart_ref']==matching['chart_ref']
    assert summary['observation_uid']==matching['uid']
    assert store.service_state('sample')['instances'][0]['observations']==before
    assert store.event_history('sample')==history
