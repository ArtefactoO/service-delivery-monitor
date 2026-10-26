import os,time
import httpx
import pytest
from joserfc import jwt
from joserfc.jwk import RSAKey
from sqlalchemy import select
from fastapi.testclient import TestClient
from sdm.api import create_app
from sdm.config import CIIdentity,Integration
from sdm.store import ci_keys,events,jobs

@pytest.fixture
def ci(store,settings):
    settings.integrations={'git':Integration(kind='gitlab',base_url='https://git.example',token_env='TEST_GITLAB',project_id=900)}
    settings.ci_identity=CIIdentity(issuer='https://git.example',audience='https://sdm.example/api/v1/ci/events',gitlab_source='git',publisher_project_id=900)
    key=RSAKey.generate_key(2048,parameters={'kid':'ci-fixture'})
    with store.engine.begin() as conn:
        conn.execute(ci_keys.insert().values(issuer=settings.ci_identity.issuer,jwks={'keys':[key.as_dict(private=False)]},fetched_at=time.time()))
    def token(**overrides):
        now=int(time.time())
        claims={'iss':'https://git.example','aud':settings.ci_identity.audience,'sub':'fixture-job','jti':'fixture-unique',
                'iat':now,'nbf':now-1,'exp':now+3600,'project_id':'100','project_path':'example/sample',
                'pipeline_id':'10','job_id':'100','pipeline_source':'push','ref':'dev','ref_type':'branch',
                'ref_protected':'false','sha':'a'*40,**overrides}
        return jwt.encode({'alg':'RS256','kid':'ci-fixture'},claims,key)
    with TestClient(create_app(settings,store)) as client:
        yield client,token


def send(ci,payload,**claims):
    client,token=ci
    return client.post('/api/v1/ci/events',json=payload,headers={'X-Producer-ID':'gitlab-ci','Authorization':'Bearer '+token(**claims)})


def test_registered_build_job_and_repeat_are_accepted(ci,event):
    payload=event(kind='build')
    assert send(ci,payload).status_code==202
    assert send(ci,payload).json()['duplicate'] is True


@pytest.mark.parametrize('claim,value',[('aud','other'),('iss','https://wrong.example'),('exp',1),('pipeline_id','11'),('job_id','101'),('project_path','other/sample'),('ref','other'),('sha','f'*40),('pipeline_source','merge_request_event'),('job_project_id','101')])
def test_invalid_or_different_ci_job_is_denied(ci,event,claim,value):
    assert send(ci,event(kind='build'),**{claim:value}).status_code in {401,403}


def test_publisher_must_be_protected_main(ci,event):
    claims={'project_id':'900','project_path':'infra/publisher','ref':'main','pipeline_source':'trigger'}
    assert send(ci,event(),**claims).status_code==403
    assert send(ci,event(),**{**claims,'ref_protected':'true'}).status_code==202
    assert send(ci,event(kind='build'),**{**claims,'ref_protected':'true'}).status_code==403


def test_new_registry_entry_needs_no_manually_configured_producer(ci,event,store):
    payload=event(kind='build');payload['service']='brand-new';payload['source']['project_id']=101;payload['attempt']['project_id']=101
    claims={'project_id':'101','project_path':'example/new'}
    response=send(ci,payload,**claims)
    assert response.status_code==503 and response.headers['Retry-After']=='60'
    assert store.list_services()[0]['key']=='sample'
    with store.engine.connect() as conn:
        assert conn.execute(select(jobs)).first() is not None
        assert conn.execute(select(events)).first() is None
    store.catalog([{'key':'brand-new','project_id':101,'project':'example/new','test_ref':'dev'}],'updated',{})
    assert send(ci,payload,**claims).status_code==202


def test_public_ci_path_never_accepts_static_or_browser_identity(ci,event):
    client,_=ci
    assert client.post('/api/v1/ci/events',json=event(),headers={'X-Producer-ID':'publisher','Authorization':'Bearer '+os.environ['TEST_PUBLISHER']}).status_code==401
    assert client.get('/api/v1/ci/events').status_code==405


def test_trigger_publisher_cannot_claim_production(ci,event):
    payload=event();payload['target']['environment']='prod';payload['publication']['values_path']='kubernetes/prod/sample/values.yaml'
    assert send(ci,payload,project_id='900',project_path='infra/publisher',ref='main',pipeline_source='trigger',ref_protected='true').status_code==403


def publisher_payload(event, environment):
    payload = event(feature=environment == 'feature')
    if environment != 'feature':
        name = 'sample-preprod' if environment == 'preprod' else 'sample'
        payload['target'] = {'environment': environment, 'instance': name}
        payload['publication']['values_path'] = f'kubernetes/{environment}/{name}/values.yaml'
    return payload


@pytest.mark.parametrize('pipeline_source', ['trigger', 'pipeline'])
@pytest.mark.parametrize('environment', ['prod', 'preprod'])
def test_protected_publisher_is_bound_to_the_signed_service_environment(ci, event, pipeline_source, environment):
    claim = 'production/sample' + ('-preprod' if environment == 'preprod' else '')
    result = send(ci, publisher_payload(event, environment), project_id='900', project_path='infra/publisher',
                  ref='main', ref_protected='true', pipeline_source=pipeline_source, environment=claim,
                  environment_protected='false')
    assert result.status_code == 202


@pytest.mark.parametrize('pipeline_source', ['trigger', 'pipeline'])
@pytest.mark.parametrize('environment', ['prod', 'preprod'])
@pytest.mark.parametrize('claim', [None, '', 'production/other', 'testing/sample', 'production/sample/extra',
                                 'production/sample-preprod/extra', False, ['production/sample']])
def test_wrong_or_missing_signed_environment_cannot_claim_production(ci, store, event, pipeline_source, environment, claim):
    result = send(ci, publisher_payload(event, environment), project_id='900', project_path='infra/publisher',
                  ref='main', ref_protected='true', pipeline_source=pipeline_source, environment=claim)
    assert result.status_code == 403
    assert result.json()['detail'] == 'publisher_environment_denied'
    with store.engine.connect() as conn:
        assert conn.execute(select(events)).first() is None


@pytest.mark.parametrize('environment,claim', [('prod', 'production/sample-preprod'), ('preprod', 'production/sample')])
def test_prod_and_preprod_claims_are_not_interchangeable(ci, event, environment, claim):
    assert send(ci, publisher_payload(event, environment), project_id='900', project_path='infra/publisher',
                ref='main', ref_protected='true', pipeline_source='trigger', environment=claim).status_code == 403


@pytest.mark.parametrize('environment', ['test', 'feature'])
@pytest.mark.parametrize('claim', ['production/sample', 'production/sample-preprod', 'production/other',
                                 'production', 'Production/sample', ['production/sample']])
def test_production_job_cannot_relabel_its_events_as_nonproduction(ci, event, environment, claim):
    assert send(ci, publisher_payload(event, environment), project_id='900', project_path='infra/publisher',
                ref='main', ref_protected='true', pipeline_source='trigger', environment=claim).status_code == 403


@pytest.mark.parametrize('claims', [{'ref': 'other'}, {'ref_protected': 'false'}, {'pipeline_source': 'push'},
                                  {'project_id': '901'}, {'job_project_id': '901'}])
def test_signed_production_environment_does_not_bypass_existing_context_guards(ci, event, claims):
    correct = {'project_id': '900', 'project_path': 'infra/publisher', 'ref': 'main', 'ref_protected': 'true',
               'pipeline_source': 'trigger', 'environment': 'production/sample'}
    assert send(ci, publisher_payload(event, 'prod'), **{**correct, **claims}).status_code in {401, 403}


def test_build_scope_does_not_depend_on_publisher_environment_names(ci, event):
    assert send(ci, event(kind='build'), environment='production/sample').status_code == 202


@pytest.mark.skipif(not os.environ.get('SDM_PUBLISHER_SOURCE'),reason='cross-repository source is mounted only for integration verification')
@pytest.mark.parametrize('failed',[False,True])
@pytest.mark.parametrize('environment',['test','prod','preprod'])
def test_real_publisher_payloads_are_accepted_by_receiver(ci,store,tmp_path,failed,environment):
    import importlib.util,sys
    source=os.environ['SDM_PUBLISHER_SOURCE'];sys.path.insert(0,source+'/ci')
    spec=importlib.util.spec_from_file_location('sdm_publisher_sender',source+'/ci/sdm_events.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    client,token=ci
    claims = {'environment': 'production/sample' + ('-preprod' if environment == 'preprod' else '')} if environment in {'prod','preprod'} else {}
    authorization=token(project_id='900',project_path='infra/publisher',ref='main',pipeline_source='trigger',ref_protected='true',**claims)
    statuses=[]
    def deliver(payload):
        response=client.post('/api/v1/ci/events',json=payload,headers={'X-Producer-ID':'gitlab-ci','Authorization':'Bearer '+authorization})
        statuses.append(response.status_code)
        assert response.status_code==202,response.text
        return response.status_code
    env={'SDM_CI_ID_TOKEN':authorization,'CI_PROJECT_ID':'900','CI_PIPELINE_ID':'10','CI_JOB_ID':'100'}
    reporter=module.Events(env,{'sample':{'project':'example/sample','project_id':100}},tmp_path/'receipt.json',deliver)
    request={'DELIVERY_SERVICE':'sample','DELIVERY_ENVIRONMENT':environment,'DELIVERY_ACTION':'upsert','DELIVERY_SOURCE_REF':'dev','DELIVERY_SOURCE_SHA':'a'*40}
    values={'namespace':'sample','chartVersion':'v1.0.0','deployments':{'app':{'annotations':{
      'delivery.example.com/source-project':'example/sample','delivery.example.com/source-ref':'dev','delivery.example.com/source-revision':'a'*40,'delivery.example.com/build-source-revision':'d'*40},
      'image':{'repository':'registry.example/sample','digest':'sha256:'+'b'*64}}}}
    reporter.bind(request);reporter.started();reporter.published(request,values,'c'*40)
    if failed:reporter.failed()
    else:reporter.verified({'metadata':{'name':'sample-preprod' if environment=='preprod' else 'sample','uid':'11111111-1111-4111-8111-111111111111','creationTimestamp':'2026-01-01T00:00:00Z'},'spec':{'destination':{'namespace':'sample'}}})
    reporter.finish()
    assert len(statuses)==4
    state=store.service_state('sample')['instances'][0]
    assert state['environment']==environment
    assert state['desired']['publication']['revision']=='c'*40
    assert (state['verified'] is None)==failed


def test_existing_foreign_service_is_forbidden_not_a_registry_retry(ci,event,store):
    store.catalog([{'key':'sample','project_id':100,'project':'example/sample','test_ref':'dev'}, {'key':'other','project_id':101,'project':'example/other','test_ref':'dev'}],'registry',{})
    payload=event(kind='build');payload['service']='other'
    assert send(ci,payload).status_code==403


def test_bad_signature_never_ingests_or_schedules_refresh(ci,event,store):
    client,token=ci;parts=token().split('.')
    parts[2]=('A' if parts[2][0]!='A' else 'B')+parts[2][1:]
    response=client.post('/api/v1/ci/events',json=event(kind='build'),headers={'X-Producer-ID':'gitlab-ci','Authorization':'Bearer '+'.'.join(parts)})
    assert response.status_code==401
    with store.engine.connect() as conn:
        assert conn.execute(select(events)).first() is None
        assert conn.execute(select(jobs)).first() is None
