import base64
from datetime import datetime, timezone
import json
import os

import httpx
import pytest
from sqlalchemy import select, update

from sdm.config import Integration
from sdm.contracts import DeliveryEvent, feature_id
from sdm.reconcile import Deferred, Reconciler, SourceFailure, published_environments, registry_from_python
from sdm.store import Store, instances, jobs, sources


def git_config(**overrides):
    return Integration(kind="gitlab", base_url="https://git.example", token_env="TEST_GITLAB", project_id=900, **overrides)


def test_literal_registry_never_executes_code():
    assert registry_from_python("SERVICES = {'new': {'project_id': 101, 'project': 'group/new'}}")[0]["key"] == "new"
    with pytest.raises(ValueError):
        registry_from_python("SERVICES = dict(project_id=__import__('os').system('false'))")


def test_budget_is_persistent_and_shared(store, settings):
    now = [1000.0]; calls = []
    settings.integrations = {"git": git_config(requests_per_window=1, window_seconds=300)}
    transport = httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(200, json={}))
    first = Reconciler(store, settings, httpx.Client(transport=transport), clock=lambda: now[0], jitter=lambda *_: 0)
    second = Reconciler(store, settings, httpx.Client(transport=transport), clock=lambda: now[0], jitter=lambda *_: 0)
    first.get("git", "/a")
    now[0] += 5
    with pytest.raises(Deferred) as caught:
        second.get("git", "/b")
    assert caught.value.until == 1300
    assert len(calls) == 1
    now[0] = 1300
    second.get("git", "/b")
    assert len(calls) == 2


def test_registry_refresh_and_conditional_request(store, settings):
    now = [1000.0]; requests = []
    settings.integrations = {"git": git_config()}
    content = "SERVICES = {'another': {'project_id': 101, 'project': 'group/another'}}"
    def handle(request):
        requests.append(request)
        if request.url.path.endswith('/repository/tree'):
            return httpx.Response(200, json=[{'type':'tree','name':'test','path':'kubernetes/test'}])
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, json={"content": base64.b64encode(content.encode()).decode(), "last_commit_id": "a" * 40}, headers={"ETag": '"v1"'})
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(handle)), clock=lambda: now[0], jitter=lambda *_: 0)
    worker.bootstrap(); worker.tick()
    now[0] += 2; worker.tick()
    assert [s["key"] for s in store.list_services()] == ["another"]
    now[0] += 601; worker.tick()
    now[0] += 2; worker.tick()
    assert len(requests) == 4
    assert requests[2].headers["if-none-match"] == '"v1"'
    assert worker.source_state('git')['state']['published_environments']==['test']
    assert requests[0].headers["private-token"] == os.environ["TEST_GITLAB"]


def test_failure_retains_snapshot_and_backs_off(store, settings):
    now = [1000.0]
    settings.integrations = {"git": git_config()}
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(429, headers={"Retry-After": "120"}))), clock=lambda: now[0], jitter=lambda *_: 0)
    worker.bootstrap(); worker.tick()
    state = worker.source_state("git")
    assert state["backoff_until"] >= 1120
    assert state["last_success_at"] is None
    assert store.list_services()[0]["key"] == "sample"
    assert not worker.tick()


def test_environment_discovery_continues_within_budget_and_refreshes_after_registry_304(store, settings):
    now=[1000.0];calls=[];folders=['test'];fail=[False]
    settings.integrations={'git':git_config(requests_per_window=1,window_seconds=300)}
    content="SERVICES = {'sample': {'project_id': 100, 'project': 'example/sample'}}"
    def handle(request):
        calls.append(request.url.path)
        if request.url.path.endswith('/repository/tree'):
            assert request.url.params['path']=='kubernetes' and request.url.params['per_page']=='100'
            if fail[0]:return httpx.Response(503)
            return httpx.Response(200,json=[{'type':'tree','name':env,'path':f'kubernetes/{env}'} for env in folders])
        if request.headers.get('if-none-match'):return httpx.Response(304)
        return httpx.Response(200,json={'content':base64.b64encode(content.encode()).decode(),'last_commit_id':'a'*40},headers={'etag':'"unchanged"'})
    worker=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(handle)),clock=lambda:now[0],jitter=lambda *_:0)
    worker.bootstrap();worker.tick()
    assert worker.source_state('git')['state'].get('_registry_pending')
    assert len(calls)==1
    now[0]=1300;worker.tick()
    assert store.environment_inventory(['git'])=={'test'}
    assert len(calls)==2
    folders[:]=['prod','feature']
    now[0]=1901;worker.tick();now[0]=2201;worker.tick()
    assert store.environment_inventory(['git'])=={'prod'}
    assert len(calls)==4 and calls[1]==calls[3]
    fail[0]=True
    now[0]=2802;worker.tick();now[0]=3102;worker.tick()
    assert store.environment_inventory(['git'])=={'prod'}
    assert worker.source_state('git')['error_code']=='http_503'


def test_environment_tree_ignores_unrelated_entries_and_rejects_truncation():
    entries=[{'type':'tree','name':name,'path':f'kubernetes/{name}'} for name in ['feature','preprod','test']]
    entries += [{'type':'blob','name':'prod','path':'kubernetes/prod'}, {'type':'tree','name':'prod','path':'elsewhere/prod'}]
    assert published_environments(json.dumps(entries).encode())==['test','preprod']
    for invalid in ({'error':'denied'}, [{}]*100):
        with pytest.raises(ValueError):published_environments(json.dumps(invalid).encode())


def test_invalid_registry_candidate_is_discarded_so_upstream_fix_can_recover(store, settings):
    now=[1000.0];invalid=[True];calls=[]
    settings.integrations={'git':git_config()}
    def handle(request):
        calls.append(request.url.path)
        if request.url.path.endswith('/repository/tree'):
            return httpx.Response(200,json=[])
        duplicate=", 'duplicate': {'project_id': 100, 'project': 'example/duplicate'}" if invalid[0] else ''
        content="SERVICES = {'sample': {'project_id': 100, 'project': 'example/sample'}"+duplicate+"}"
        return httpx.Response(200,json={'content':base64.b64encode(content.encode()).decode(),'last_commit_id':'a'*40})
    worker=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(handle)),clock=lambda:now[0],jitter=lambda *_:0)
    worker.bootstrap();worker.tick();now[0]=1002;worker.tick()
    failed=worker.source_state('git')
    assert failed['error_code']=='duplicate_registry_identity' and '_registry_pending' not in failed['state']
    invalid[0]=False;now[0]=1032;worker.tick();now[0]=1034;worker.tick()
    assert worker.source_state('git')['error_code'] is None
    assert len(calls)==4


def test_registry_continuation_does_not_consume_a_newer_refresh_request(store, settings):
    now=[1000.0]
    settings.integrations={'git':git_config()}
    content="SERVICES = {'sample': {'project_id': 100, 'project': 'example/sample'}}"
    def handle(request):
        return httpx.Response(200,json=[] if request.url.path.endswith('/repository/tree') else {
            'content':base64.b64encode(content.encode()).decode(),'last_commit_id':'a'*40})
    worker=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(handle)),clock=lambda:now[0],jitter=lambda *_:0)
    worker.bootstrap();worker.tick()
    with store.engine.begin() as conn:Store.schedule(conn,'git',1002)
    now[0]=1002;worker.tick()
    with store.engine.connect() as conn:due=conn.execute(select(jobs.c.due_at).where(jobs.c.name=='git')).scalar_one()
    assert due==1062


def test_catalog_environments_use_publisher_snapshot_and_only_live_feature_instances(client, store, settings):
    settings.integrations={'git':git_config()}
    with store.engine.begin() as conn:
        store.ensure_source(conn,'git')
        conn.execute(update(sources).where(sources.c.name=='git').values(state={'published_environments':['prod','feature']}))
        conn.execute(instances.insert().values(id='sample:feature:feature-one',service='sample',environment='feature',name='feature-one',
            source_ref='feature/one',lifecycle={},observations={'argo':{'present':True}},updated_at=1))
    headers={'Authorization':'Bearer '+os.environ['TEST_READER']}
    assert client.get('/api/v1/services',headers=headers).json()['environments']==['prod','feature']
    with store.engine.begin() as conn:
        conn.execute(update(instances).values(lifecycle={'stopped_at':'2026-01-01T00:00:00Z'}))
    assert client.get('/api/v1/services',headers=headers).json()['environments']==['prod']
    with store.engine.begin() as conn:
        conn.execute(update(sources).values(state={'published_environments':[]}))
    assert client.get('/api/v1/services',headers=headers).json()['environments']==[]
    assert store.environment_inventory(['unconfigured']) is None


def test_argo_feature_discovery_uses_metadata_and_caches_values(store, settings, drain_checks):
    ref = "feature/topic"
    name = feature_id("sample", "example/sample", ref)
    settings.integrations = {
        "git": git_config(),
        "argo": Integration(kind="argocd", base_url="https://argo.example", token_env="TEST_ARGO", projects=["services"],
            environments=["feature"], deployment_repo_url="https://git.example/group/deployments.git", gitlab_source="git"),
    }
    now = [datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()]; calls = []
    app = {"metadata": {"name": name, "uid": "11111111-1111-4111-8111-111111111111", "creationTimestamp": "2026-01-01T00:00:00Z"},
        "spec": {"project": "services", "destination": {"namespace": "sample"}, "sources": [
            {"repoURL": "https://git.example/group/chart.git", "targetRevision": "v1.0.0", "helm": {"valueFiles": [f"$values/kubernetes/feature/{name}/values.yaml"], "values": "must-not-store-inline-values"}},
            {"repoURL": "https://git.example/group/deployments.git", "ref": "values", "targetRevision": "main"}]},
        "status": {"sync": {"status": "Synced", "revisions": ["b" * 40, "c" * 40]}, "health": {"status": "Healthy"}, "resources": []}}
    yaml = """namespace: sample
deployments:
  api:
    annotations:
      delivery.example.com/source-project: example/sample
      delivery.example.com/source-ref: feature/topic
      delivery.example.com/source-revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    config:
      files:
        app.yaml: must-not-store-config-content
    image:
      repository: registry.example/sample
      digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
"""
    def handle(request):
        calls.append(str(request.url))
        if request.url.host == "argo.example":
            return httpx.Response(200, json={"items": [app]})
        if request.url.path.endswith('/repository/tree'):
            return httpx.Response(200, json=[{"type":"blob","path":f"kubernetes/feature/{name}/values.yaml","id":"e"*40}])
        return httpx.Response(200, content=yaml.encode())
    worker = Reconciler(store, settings, httpx.Client(transport=httpx.MockTransport(handle)), clock=lambda: now[0], jitter=lambda *_: 0)
    with store.engine.begin() as conn:
        for key in settings.integrations:
            store.ensure_source(conn, key)
    worker.argo("argo")
    assert store.service_state("sample")["instances"] == []  # Discovery never waits for per-app network reads.
    drain_checks(worker)
    state = store.service_state("sample", now[0])
    assert state["instances"][0]["lifetime_seconds"] == 3 * 86400
    assert state["instances"][0]["verified"] is None
    serialized = json.dumps(state) + json.dumps(store.source_status())
    assert "must-not-store" not in serialized
    assert len(calls) == 3
    now[0] += 601; worker.argo("argo")
    drain_checks(worker)
    assert len(calls) == 4  # Same immutable file and metadata are reused.


def test_argocd_events_coalesce_into_one_job(store, settings, event):
    settings.integrations = {"argo": Integration(kind="argocd", base_url="https://argo.example", token_env="TEST_ARGO",
        projects=["services"], environments=["test"], deployment_repo_url="https://git.example/group/deployments.git")}
    producer = settings.producers["publisher"]
    for pipeline in range(1, 10):
        store.ingest(DeliveryEvent.model_validate(event(kind="argocd", pipeline=pipeline)), "publisher", producer, settings.integrations, now=1000)
    with store.engine.connect() as conn:
        queued = conn.execute(select(jobs)).mappings().all()
    assert len(queued) == 1
    assert queued[0]["due_at"] == 1015


def test_absence_check_does_not_refresh_historical_resource_status_or_rewrite_events(store, settings, event):
    from sdm.store import events
    config=Integration(kind='argocd',base_url='https://argo.example',token_env='TEST_ARGO',
        projects=['services'],environments=['test'],deployment_repo_url='https://git.example/deployments.git')
    settings.integrations={'argo':config}
    producer=settings.producers['publisher']
    store.ingest(DeliveryEvent.model_validate(event(kind='deployment',status='failed',pipeline=10)),'publisher',producer,{})
    with store.engine.connect() as conn:
        before=[dict(row) for row in conn.execute(select(events)).mappings()]
    store.ingest(DeliveryEvent.model_validate(event(kind='deployment',pipeline=20)),'publisher',producer,{})
    snapshot={'present':True,'observed_at':'2026-01-01T00:00:00+00:00','sync':'OutOfSync','health':'Degraded',
        'resources':[{'kind':'Deployment','name':'sample-api','health':'Degraded'}]}
    with store.engine.begin() as conn:
        conn.execute(update(instances).values(observations={'argo':snapshot}))
    worker=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(lambda _:httpx.Response(200,json={'items':[]}))),
        clock=lambda:10000000000,jitter=lambda *_:0)
    worker.bootstrap();worker.argo('argo')
    observed=store.service_state('sample')['instances'][0]['observations']['argo']
    assert observed['present'] is False and observed['observed_at']==snapshot['observed_at']
    assert observed['presence_checked_at']!=observed['observed_at']
    assert observed['health']=='Degraded' and observed['sync']=='OutOfSync' and observed['resources']==snapshot['resources']
    with store.engine.connect() as conn:
        after=[dict(row) for row in conn.execute(select(events).where(events.c.id.in_([row['id'] for row in before]))).mappings()]
    assert after==before
    assert store.service_state('sample')['instances'][0]['verified']['ordering'][0]==20


def test_registry_error_does_not_remove_catalog(store):
    from sdm.store import Rejected
    with pytest.raises(Rejected):
        store.catalog([{"key": "sample", "project_id": 555, "project": "another/sample", "test_ref": None}], "bad", {})
    assert store.list_services()[0]["project_id"] == 100


def test_integrations_cannot_split_one_origin_budget(settings):
    from sdm.config import Settings
    raw = settings.model_dump()
    raw["integrations"] = {
        "a": git_config().model_dump(),
        "b": git_config().model_copy(update={"base_url": "https://git.example:443/another"}).model_dump(),
    }
    with pytest.raises(ValueError, match="one integration budget"):
        Settings.model_validate(raw)


@pytest.mark.parametrize("invalid", ["timestamp", "uid", "repository"])
def test_argo_rejects_invalid_metadata_before_persistence(invalid):
    from sdm.reconcile import app_snapshot
    integration = Integration(kind="argocd", base_url="https://argo.example", token_env="TEST_ARGO",
        projects=["services"], environments=["test"], deployment_repo_url="https://git.example/deployments.git")
    app = {"metadata": {"name": "sample", "uid": "11111111-1111-4111-8111-111111111111",
        "creationTimestamp": "2026-01-01T00:00:00Z"},
        "spec": {"project": "services", "destination": {"namespace": "sample"}, "sources": [
            {"repoURL": "https://git.example/chart.git", "helm": {"valueFiles": ["$values/kubernetes/test/sample/values.yaml"]}},
            {"repoURL": "https://git.example/deployments.git", "ref": "values"}]},
        "status": {"sync": {"revisions": ["a" * 40, "b" * 40]}}}
    assert app_snapshot(app, integration)["name"] == "sample"
    if invalid == "timestamp":
        app["metadata"]["creationTimestamp"] = "2026-01-01T00:00:00"
    elif invalid == "uid":
        app["metadata"]["uid"] = "not-a-uid"
    else:
        app["spec"]["sources"][0]["repoURL"] = "https://user:credential@git.example/chart.git"
    with pytest.raises(ValueError):
        app_snapshot(app, integration)


def test_metadata_projection_keeps_references_not_values():
    from sdm.reconcile import values_projection
    import yaml
    payload = {'namespace': 'sample', 'deployments': {'api': {
        'annotations': {'delivery.example.com/source-project': 'example/sample', 'delivery.example.com/source-ref': 'dev', 'delivery.example.com/source-revision': 'a'*40},
        'env': [{'name': 'PASSWORD', 'value': 'do-not-store-environment'}, {'name': 'CONFIG', 'valueFrom': {'configMapKeyRef': {'name': 'settings', 'key': 'app'}}}],
        'config': {'files': {'app.yaml': 'do-not-store-config'}},
        'externalSecret': {'enabled': True, 'secretStoreRef': {'name': 'vault-services-test'}, 'data': [{'secretKey': 'password', 'remoteRef': {'key': 'sample/test', 'property': 'password'}}]},
    }}}
    result = values_projection(yaml.safe_dump(payload).encode())
    assert 'do-not-store' not in json.dumps(result)
    item = result['workloads'][0]
    assert item['config_files'] == ['app.yaml']
    assert item['external_secret']['remote_refs'] == [{'key': 'sample/test', 'property': 'password', 'mode': 'property'}]
    assert item['references'] == [{'kind': 'ConfigMap', 'name': 'settings', 'relation': 'env'}]


def test_catalog_api_tracks_registry_without_frontend_inventory(client, store, monkeypatch):
    headers = {'Authorization': 'Bearer ' + os.environ['TEST_READER']}
    store.catalog([{'key': 'brand-new', 'project_id': 999, 'project': 'group/brand-new', 'test_ref': 'dev'}], 'new-revision', {})
    data = client.get('/api/v1/services', headers=headers).json()
    assert [item['key'] for item in data['items']] == ['brand-new']
    assert data['items'][0]['instances'] == []
    assert client.get('/api/v1/services/sample', headers=headers).status_code == 404


def test_ci_keys_share_origin_budget_and_store_only_public_material(store,settings):
    from joserfc.jwk import RSAKey
    from sdm.config import CIIdentity
    from sdm.store import ci_keys
    key=RSAKey.generate_key(2048,parameters={'kid':'fixture'})
    settings.integrations={'git':git_config(requests_per_window=1,window_seconds=300)}
    settings.ci_identity=CIIdentity(issuer='https://git.example',audience='https://sdm.example/api/v1/ci/events',gitlab_source='git',publisher_project_id=900)
    now=[1000.0];calls=[]
    content="SERVICES = {'sample': {'project_id': 100, 'project': 'example/sample'}}"
    def handle(request):
        calls.append(request.url.path)
        if request.url.path.endswith('/keys'):return httpx.Response(200,json={'keys':[key.as_dict(private=True)]})
        return httpx.Response(200,json={'content':base64.b64encode(content.encode()).decode(),'last_commit_id':'a'*40})
    worker=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(handle)),clock=lambda:now[0])
    worker.bootstrap()
    with pytest.raises(Deferred):worker.registry('git')
    assert len(calls)==1
    with store.engine.connect() as conn:
        cached=conn.execute(select(ci_keys)).mappings().one()
    assert not {'d','p','q','dp','dq','qi'} & set(cached['jwks']['keys'][0])
    with pytest.raises(Deferred):worker.registry('git')
    assert len(calls)==1
    now[0]=1300
    with pytest.raises(Deferred):worker.registry('git')
    assert len(calls)==2
