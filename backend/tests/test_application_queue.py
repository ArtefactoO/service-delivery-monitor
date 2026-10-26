import copy
import json

import httpx
from sqlalchemy import select, update

from sdm import application_queue
from sdm.reconcile import SourceFailure
from sdm.store import application_checks as checks, events, instances, repository_trees, value_metadata
from scale_fixtures import Inventory


def finish(inventory, limit=400):
    expected = sum(map(len, inventory.apps.values()))
    for _ in range(limit):
        inventory.step()
        with inventory.store.engine.connect() as conn:
            rows = conn.execute(select(checks.c.last_success_at)).scalars().all()
        if len(rows) == expected and all(row is not None for row in rows):
            return
    raise AssertionError('queue did not finish')


def test_independent_checks_use_cache_and_one_persistent_budget_per_origin(store, settings):
    inventory = Inventory(store, settings, count=3, features=True)
    try:
        finish(inventory)
        calls = copy.deepcopy(inventory.calls)
        assert sum(c['path'].endswith('resource-tree') for c in calls) == 9
        assert not any(c['path'].endswith('/resource') or c['path'].endswith('/raw') for c in calls)
        for source in settings.integrations:
            times = [c['at'] for c in calls if c['source'] == source]
            assert all(right-left >= 2 for left,right in zip(times,times[1:]))
        with store.engine.connect() as conn:
            serialized = json.dumps([dict(r) for r in conn.execute(select(checks)).mappings()])
            serialized += json.dumps([dict(r) for r in conn.execute(select(value_metadata)).mappings()])
        assert 'NEVER-PERSIST' not in serialized
        assert all(len(s['instances']) == 3 for s in store.catalog_state())
    finally:
        inventory.close()


def test_foreign_publisher_commit_reuses_file_metadata_without_manifest_requests(store, settings):
    inventory = Inventory(store, settings, count=3)
    try:
        finish(inventory)
        before = store.service_state('svc-000')['instances']
        baseline = len(inventory.calls)
        inventory.now[0] += 3
        for apps in inventory.apps.values():
            for app in apps:app['status']['sync']['revisions'][1] = 'd'*40
        inventory.worker.argo('argo-test')
        inventory.worker.argo('argo-prod')
        for _ in range(40):inventory.step()
        fresh = inventory.calls[baseline:]
        assert sum(c['path'].endswith('/repository/tree') and c['params'].get('recursive')=='true' for c in fresh) == 1
        assert not any(c['path'].endswith('/raw') or c['path'].endswith('/resource-tree') for c in fresh)
        after = store.service_state('svc-000')['instances']
        assert all(next(iter(i['observations'].values()))['values_revision']=='d'*40 for i in after)
        assert [next(iter(i['observations'].values()))['runtime'] for i in after] == [next(iter(i['observations'].values()))['runtime'] for i in before]
        assert [next(iter(i['observations'].values()))['observed_at'] for i in after] == [next(iter(i['observations'].values()))['observed_at'] for i in before]
        with store.engine.connect() as conn:
            assert all(row is None for row in conn.execute(select(checks.c.requested_at)).scalars())
    finally:
        inventory.close()


def test_adaptive_cadence_reserves_headroom_without_raising_http_budget(settings):
    from sdm.config import Integration
    config=Integration(kind='argocd',base_url='https://argo.example',token_env='TEST_ARGO',
                       requests_per_window=120,runtime_enabled=True,projects=['services'],environments=['test'],
                       deployment_repo_url='https://git.example/deployments.git')
    assert application_queue.resource_interval(config,120)==600
    assert 600 <= application_queue.resource_interval(config,240) <= 900
    assert application_queue.resource_interval(config,400)>900
    assert config.requests_per_window==120


def test_priority_cannot_starve_ordinary_checks(store, settings):
    inventory = Inventory(store, settings, count=3)
    try:
        inventory.worker.argo('argo-test')
        now = inventory.now[0]
        with store.engine.begin() as conn:
            conn.execute(update(checks).where(checks.c.source=='argo-test').values(priority=False))
            conn.execute(update(checks).where(checks.c.source=='argo-test',checks.c.name=='svc-000').values(priority=True))
        selected=[]
        for _ in range(8):
            inventory.now[0]+=2
            row=application_queue.choose(inventory.worker,['argo-test'])
            selected.append(row['name'])
        assert selected.count('svc-000')==6
        assert {'svc-001','svc-002'}.issubset(selected)
        assert inventory.calls[0]['at']==now
    finally:
        inventory.close()


def test_request_arriving_during_work_survives_completion_and_waits_for_new_inventory(store, settings):
    inventory = Inventory(store, settings, count=1)
    try:
        inventory.worker.argo('argo-test')
        inventory.now[0]+=2
        row=application_queue.choose(inventory.worker,['argo-test'])
        def interleaved(*args):
            inventory.now[0]+=1
            with store.engine.begin() as conn:store.request_application(conn,'argo-test','svc-000',inventory.now[0])
        inventory.worker.collect_application=interleaved
        application_queue.run(inventory.worker,row)
        with store.engine.connect() as conn:
            saved=conn.execute(select(checks).where(checks.c.source=='argo-test')).mappings().one()
        assert saved['priority'] and saved['generation']==1
        assert saved['due_at']==inventory.now[0]+60
        inventory.now[0]+=61
        assert application_queue.choose(inventory.worker,['argo-test']) is None
        inventory.worker.argo('argo-test')
        assert application_queue.choose(inventory.worker,['argo-test']) is not None
    finally:
        inventory.close()


def test_legacy_continuation_is_imported_without_declaring_absence_or_losing_progress(store, settings):
    inventory=Inventory(store,settings,count=1)
    try:
        from sdm.reconcile import app_snapshot
        from sdm.store import sources, iso
        app=app_snapshot(inventory.apps['argo-test'][0],settings.integrations['argo-test'])
        app['_runtime']={'projection_version':6,'pending':[],'application_uid':app['uid'],'objects':[], 'tree':[], 'observed_at':iso(inventory.now[0])}
        with store.engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.name=='argo-test').values(state={
                'pending':[app],'seen':[],'observed_at':iso(inventory.now[0])}))
        snapshot_at=inventory.now[0]
        before=store.service_state('svc-000',now=snapshot_at)['instances']
        application_queue.migrate_legacy(inventory.worker,'argo-test')
        with store.engine.connect() as conn:row=conn.execute(select(checks).where(checks.c.source=='argo-test')).mappings().one()
        assert row['progress']['_runtime']==app['_runtime']
        assert 'pending' not in inventory.worker.source_state('argo-test')['state']
        assert store.service_state('svc-000',now=snapshot_at)['instances']==before
    finally:
        inventory.close()


def test_snapshot_version_prevents_obsolete_check_from_writing_observations(store, settings):
    inventory=Inventory(store,settings,count=1)
    try:
        inventory.worker.argo('argo-test')
        inventory.now[0]+=2
        row=application_queue.choose(inventory.worker,['argo-test'])
        before=store.service_state('svc-000')['instances']
        with store.engine.begin() as conn:
            conn.execute(update(checks).where(checks.c.source=='argo-test').values(version=checks.c.version+1))
        application_queue.run(inventory.worker,row)
        assert store.service_state('svc-000')['instances']==before
        with store.engine.connect() as conn:assert conn.execute(select(checks.c.last_success_at).where(checks.c.source=='argo-test')).scalar() is None
    finally:
        inventory.close()


def test_queue_and_budget_resume_after_worker_restart(store, settings):
    inventory=Inventory(store,settings,count=2,warm=False)
    try:
        for _ in range(12):inventory.step()
        from sdm.reconcile import Reconciler
        old=inventory.worker
        inventory.worker=Reconciler(store,settings,httpx.Client(transport=inventory.transport),clock=lambda:inventory.now[0],jitter=lambda *_:0)
        budgets={s['name']:(s['window_start'],s['window_count']) for s in store.source_status()}
        inventory.worker.bootstrap()
        assert {s['name']:(s['window_start'],s['window_count']) for s in store.source_status()}==budgets
        old.client.close()
        finish(inventory)
        for source,apps in inventory.apps.items():
            for app in apps:
                queries=[c for c in inventory.calls if c['source']==source and '/'+app['metadata']['name']+'/' in c['path']]
                assert len([c for c in queries if c['path'].endswith('/resource-tree')])==1
                assert len([c for c in queries if c['path'].endswith('/resource')])==2
    finally:
        inventory.close()


def test_gitlab_failure_does_not_pause_cached_argo_resource_checks(store, settings):
    inventory=Inventory(store,settings,count=3)
    try:
        with store.engine.begin() as conn:
            from sdm.store import jobs
            conn.execute(update(jobs).where(jobs.c.name=='git').values(due_at=inventory.now[0]+10000))
        inventory.apps['argo-test'][0]['status']['sync']['revisions'][1]='d'*40
        original=inventory.handle
        def unavailable(request):
            return httpx.Response(503) if request.url.host=='git.example' else original(request)
        inventory.worker.client.close()
        inventory.worker.client=httpx.Client(transport=httpx.MockTransport(unavailable))
        for _ in range(50):inventory.step()
        with store.engine.connect() as conn:
            good=conn.execute(select(checks).where(checks.c.last_success_at.is_not(None))).mappings().all()
        assert len(good)==5
        assert inventory.worker.source_state('git')['error_code']=='http_503'
        assert inventory.worker.source_state('argo-test')['backoff_until']==0
        assert inventory.worker.source_state('argo-test')['failures']==0
    finally:
        inventory.close()


def test_projected_large_inventory_is_bounded_and_never_persists_unused_app_fields(store, settings):
    inventory=Inventory(store,settings,count=1)
    try:
        app=inventory.apps['argo-test'][0]
        app['status']['history']=[{'unused':'NEVER-PERSIST-'+'x'*(3*1024*1024)}]
        inventory.worker.client.close()
        inventory.worker.client=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'items':[app]})))
        inventory.worker.argo('argo-test')  # Over 2 MiB remains allowed only for the bounded application list.
        with store.engine.connect() as conn:
            snapshots=json.dumps(conn.execute(select(checks.c.snapshot)).scalars().all())
        assert 'NEVER-PERSIST' not in snapshots and len(snapshots)<20000
        inventory.now[0]+=2
        app['status']['history']=[{'unused':'x'*(33*1024*1024)}]
        import pytest
        with pytest.raises(SourceFailure,match='response_too_large'):
            inventory.worker.argo('argo-test')
        assert len(store.catalog_state())==1
    finally:
        inventory.close()


def test_incomplete_argo_identity_never_confirms_absence_or_removes_queue(store, settings):
    import pytest
    inventory=Inventory(store,settings,count=1)
    try:
        finish(inventory)
        before=store.service_state('svc-000')['instances']
        with store.engine.connect() as conn:queued=[dict(row) for row in conn.execute(select(checks)).mappings()]
        for raw in [{'metadata':{'name':'svc-000','creationTimestamp':'2026-01-01T00:00:00Z'}},
                    {'metadata':{'name':'svc-000'},'spec':{'project':'argo-test'}}]:
            inventory.now[0]+=3
            inventory.worker.client.close()
            inventory.worker.client=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'items':[raw]})))
            with pytest.raises(SourceFailure,match='incomplete_application_list'):
                inventory.worker.argo('argo-test')
            assert store.service_state('svc-000')['instances']==before
            with store.engine.connect() as conn:assert [dict(row) for row in conn.execute(select(checks)).mappings()]==queued
    finally:
        inventory.close()


def test_confirmed_stopped_feature_snapshot_is_immutable_during_later_discovery(store, settings):
    inventory=Inventory(store,settings,count=1,features=True)
    try:
        from sdm.store import iso
        with store.engine.begin() as conn:
            row=dict(conn.execute(select(instances).where(instances.c.environment=='feature')).mappings().one())
            conn.execute(update(instances).where(instances.c.id==row['id']).values(lifecycle={
                **row['lifecycle'],'stopped_at':iso(inventory.now[0])}))
        before=next(i for i in store.service_state('svc-000')['instances'] if i['environment']=='feature')
        finish(inventory)
        after=next(i for i in store.service_state('svc-000')['instances'] if i['environment']=='feature')
        assert after==before
        assert len([c for c in inventory.calls if c['path'].endswith('/resource-tree')])==2
    finally:
        inventory.close()


def test_additive_queue_initialization_preserves_existing_schema_v1_receipts(client, store, event, headers):
    assert client.post('/api/v1/events',headers=headers,json=event()).status_code==202
    before=store.event_history('sample')
    with store.engine.begin() as conn:
        for table in [checks,repository_trees,value_metadata]:table.drop(conn)
    store.initialize()
    assert store.ready()
    assert store.event_history('sample')==before
    with store.engine.connect() as conn:
        for table in [checks,repository_trees,value_metadata]:
            assert not conn.execute(select(table)).first()
