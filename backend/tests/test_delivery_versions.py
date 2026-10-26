import copy
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from sdm import delivery_versions as versions
from sdm.reconcile_errors import Deferred, SourceFailure
from sdm.store import value_metadata


SERVICE={'project_id':100,'key':'sample','project':'example/sample'}
PROJECTION={'build_revision':'a'*40,'release_operation':'b'*64,
            'images':[{'repository':'registry.example/sample','digest':'sha256:'+'c'*64}]}


def tag():
    record={'schema':1,'scope':'100:sample:prod','id':'b'*64,'project':'100','service':'sample',
        'sha':'a'*40,'images':{'registry.example/sample':'sha256:'+'c'*64},'tag':'v1.2.3','version':'1.2.3',
        'publication_revision':'d'*40,'values_sha256':'e'*64}
    return {'name':'v1.2.3','commit':{'id':'a'*40},'message':'project application release\n\nDelivery-Release: '+json.dumps(record)}


def worker(store, responses):
    from sdm.reconcile import Reconciler
    now=[1000.0];calls=[]
    def get(source,path,params):
        calls.append((source,path,params))
        value=responses.pop(0)
        if isinstance(value,Exception):raise value
        return value if isinstance(value,bytes) else json.dumps(value).encode(),None
    w=SimpleNamespace(store=store,settings=SimpleNamespace(integrations={'git':SimpleNamespace(project_id=900)}),
                      clock=lambda:now[0],get=get,origin_failure=Reconciler.origin_failure)
    return w,now,calls


@pytest.mark.parametrize('content',[
    b'include: {project: platform/ci-cd, ref: "$CI_REF"}',
    b'include: [{project: platform/ci-cd, ref: v1}, {project: platform/ci-cd, ref: v2}]',
    b'include: {project: other/ci-cd, ref: v9.9.9}',
])
def test_ci_does_not_guess_dynamic_conflicting_or_foreign_refs(content):
    assert versions.ci_pin(content) is None


def test_ci_uses_build_commit_and_persists_only_pin(store):
    w,now,calls=worker(store,[b'include: {project: platform/ci-cd, ref: v3.0.0}\nvariables: {PASSWORD: NEVER-PERSIST}'])
    first=versions.build_ci(w,'git','example/sample','a'*40)
    assert first==({'project':versions.CI_PROJECT,'ref':'v3.0.0','revision':'a'*40},None)
    now[0]+=3600
    assert versions.build_ci(w,'git','example/sample','a'*40)==first
    assert len(calls)==1 and calls[0][2]=={'ref':'a'*40}
    with store.engine.connect() as conn:
        assert 'NEVER-PERSIST' not in json.dumps(conn.execute(select(value_metadata.c.projection)).scalars().all())


@pytest.mark.parametrize('field,value',[
    ('id','f'*64),('images',{'registry.example/other':'sha256:'+'c'*64}),('sha','f'*40),
    ('scope','100:other:prod'),('service','other'),('project','101'),('publication_revision','main')])
def test_release_requires_matching_operation_source_scope_and_complete_image_bundle(field,value):
    candidate=tag();record=json.loads(candidate['message'].split('Delivery-Release: ')[1]);record[field]=value
    candidate['message']='Delivery-Release: '+json.dumps(record)
    assert versions.release_tag(candidate,SERVICE,PROJECTION) is None


def test_release_selects_observed_operation_not_newest_tag_or_same_source_sha(store):
    wrong=tag();wrong['name']='v9.9.9';wrong['message']=wrong['message'].replace('b'*64,'f'*64)
    w,now,calls=worker(store,[[wrong,tag()]])
    expected=versions.registered_release(w,'git',SERVICE,PROJECTION)
    assert expected[0]['tag']=='v1.2.3'
    assert versions.registered_release(w,'git',SERVICE,PROJECTION)==expected
    assert len(calls)==1


def test_pending_tag_is_retried_after_registration(store):
    w,now,calls=worker(store,[[],[tag()]])
    assert versions.registered_release(w,'git',SERVICE,PROJECTION)[0] is None
    assert versions.registered_release(w,'git',SERVICE,PROJECTION)[0] is None
    assert len(calls)==1
    now[0]+=versions.RETRY_SECONDS+1
    assert versions.registered_release(w,'git',SERVICE,PROJECTION)[0]['tag']=='v1.2.3'


def test_tag_pagination_resumes_after_shared_budget_deferral(store):
    w,now,calls=worker(store,[[{'name':'unrelated'}]*100,Deferred(1100),[tag()]])
    with pytest.raises(Deferred):versions.registered_release(w,'git',SERVICE,PROJECTION)
    assert versions.registered_release(w,'git',SERVICE,PROJECTION)[0]['tag']=='v1.2.3'
    assert [c[2]['page'] for c in calls]==[1,2,2]


def test_optional_version_failure_does_not_fail_runtime_or_invent_release(store):
    w,_,_=worker(store,[SourceFailure('http_403')])
    before=copy.deepcopy(PROJECTION)
    result=versions.enrich(w,SimpleNamespace(gitlab_source='git'),{'environment':'test'},PROJECTION,SERVICE)
    assert result['version_errors']=={'ci':'http_403'} and 'ci' not in result and 'release' not in result
    assert PROJECTION==before


def test_test_environment_never_inherits_production_release(store):
    w,_,calls=worker(store,[b'include: []'])
    result=versions.enrich(w,SimpleNamespace(gitlab_source='git'),{'environment':'test'},
        {**PROJECTION,'release':{'tag':'stale-prod'}},SERVICE)
    assert 'release' not in result and len(calls)==1


def test_collected_ci_metadata_reaches_catalog_without_rewriting_receipts(store, settings):
    from scale_fixtures import Inventory
    from test_application_queue import finish
    inventory=Inventory(store,settings,count=1,features=True)
    try:
        ci={'project':versions.CI_PROJECT,'ref':'v3.0.0','revision':'a'*40}
        versions.remember(inventory.worker,'git','ci-pin',['example/svc-000','a'*40],complete=True,value=ci)
        history=store.event_history('svc-000')
        finish(inventory)
        catalog=next(s for s in store.catalog_state() if s['key']=='svc-000')
        assert all(i['ci']==ci for i in catalog['instances'])
        assert all(next(iter(i['observations'].values()))['git']['ci']==ci
                   for i in store.service_state('svc-000')['instances'])
        assert store.event_history('svc-000')==history
    finally:inventory.close()


def test_optional_metadata_http_429_keeps_shared_source_backoff(store, settings):
    import httpx
    from sdm.config import Integration
    from sdm.reconcile import Reconciler
    settings.integrations={'git':Integration(kind='gitlab',base_url='https://git.example',token_env='TEST_GITLAB',project_id=900)}
    w=Reconciler(store,settings,httpx.Client(transport=httpx.MockTransport(
        lambda _:httpx.Response(429,headers={'Retry-After':'120'}))),clock=lambda:1000,jitter=lambda *_:0)
    try:
        w.bootstrap()
        assert versions.build_ci(w,'git','example/sample','a'*40)==(None,'http_429')
        assert w.source_state('git')['backoff_until']>=1120
    finally:w.client.close()
