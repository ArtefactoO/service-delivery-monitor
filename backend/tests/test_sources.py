import json
import os

from sqlalchemy import update

from sdm.config import Integration
from sdm.store import sources


def test_source_status_exposes_request_limits_and_budget_without_integration_or_continuation_data(client, settings, store):
    settings.integrations['publisher']=Integration(kind='gitlab',base_url='https://git.example',
        token_env='PRIVATE_TOKEN_ENV',project_id=900,interval_seconds=900,
        requests_per_window=7,window_seconds=120,min_request_interval_seconds=3,timeout_seconds=4)
    with store.engine.begin() as conn:
        store.ensure_source(conn,'publisher')
        conn.execute(update(sources).where(sources.c.name=='publisher').values(
            state={'pending':'private-continuation'},window_start=1000,window_count=6,
            next_request_at=1003,backoff_until=1100,failures=2,error_code='http_429'))
    response=client.get('/api/v1/sources',headers={'Authorization':'Bearer '+os.environ['TEST_READER']})
    assert response.status_code==200
    items=response.json()['items']
    actual=next(item for item in items if item['name']=='publisher')
    assert {key:actual[key] for key in ['kind','interval_seconds','requests_per_window','window_seconds',
        'min_request_interval_seconds','timeout_seconds']}=={
        'kind':'gitlab','interval_seconds':900,'requests_per_window':7,'window_seconds':120,
        'min_request_interval_seconds':3,'timeout_seconds':4}
    assert {key:actual[key] for key in ['window_start','window_count','next_request_at','backoff_until','failures','error_code']}=={
        'window_start':1000,'window_count':6,'next_request_at':1003,'backoff_until':1100,'failures':2,'error_code':'http_429'}
    assert not {'state','token_env','notification_token_env','base_url','deployment_repo_url'} & actual.keys()
    assert 'private-continuation' not in json.dumps(items)
    assert 'PRIVATE_TOKEN_ENV' not in json.dumps(items)
    bootstrap=next(item for item in items if item['name']=='registry')
    assert bootstrap['kind']=='bootstrap'
    assert all(bootstrap[key] is None for key in ['interval_seconds','requests_per_window','window_seconds',
        'min_request_interval_seconds','timeout_seconds'])


def test_source_status_requires_reader_identity(client):
    assert client.get('/api/v1/sources').status_code==401


def test_application_queue_exposes_failure_identity_without_snapshot_or_continuation(client, settings, store):
    import time
    from sdm.store import application_checks
    now=time.time()
    settings.integrations['argo']=Integration(kind='argocd',base_url='https://argo.example',token_env='PRIVATE_TOKEN_ENV',
        projects=['services'],environments=['test'],deployment_repo_url='https://git.example/deployments.git',
        runtime_enabled=True,requests_per_window=120)
    with store.engine.begin() as conn:
        store.ensure_source(conn,'argo')
        conn.execute(update(sources).where(sources.c.name=='argo').values(state={'count':240}))
        conn.execute(application_checks.insert().values(source='argo',name='private-name',due_at=now-100,
            snapshot={'private':'private-snapshot'},progress={'private':'private-continuation'},error_code='http_404'))
    response=client.get('/api/v1/sources',headers={'Authorization':'Bearer '+os.environ['TEST_READER']})
    assert response.status_code==200
    row=next(item for item in response.json()['items'] if item['name']=='argo')
    assert row['tracked_applications']==row['pending_applications']==row['application_error_count']==1
    assert row['resource_interval_seconds']==754
    assert row['oldest_pending_at']==now-100
    assert row['error_code']=='partial_application_failure'
    assert row['application_errors']==[{'application':'private-name','code':'http_404'}]
    assert 'private-snapshot' not in response.text and 'private-continuation' not in response.text
    assert 'PRIVATE_TOKEN_ENV' not in response.text


def test_last_application_error_survives_recovery_without_active_failure(client, settings, store, caplog):
    from sdm.reconcile import Reconciler
    settings.integrations['argo']=Integration(kind='argocd',base_url='https://argo.example',token_env='TEST_ARGO',
        projects=['services'],environments=['test'],deployment_repo_url='https://git.example/deployments.git')
    worker=Reconciler(store,settings,clock=lambda:1000)
    with store.engine.begin() as conn:store.ensure_source(conn,'argo')
    worker.record_application_error('argo','sample','unresolved_values_revision')
    response=client.get('/api/v1/sources',headers={'Authorization':'Bearer '+os.environ['TEST_READER']})
    row=next(item for item in response.json()['items'] if item['name']=='argo')
    assert row['error_code'] is None and row['application_errors']==[]
    assert row['last_application_error']=={'application':'sample','code':'unresolved_values_revision','checked_at':1000}
    assert 'application=sample code=unresolved_values_revision' in caplog.text
