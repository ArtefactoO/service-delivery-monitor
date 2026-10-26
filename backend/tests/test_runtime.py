import json
import pytest
from sdm.runtime import PROJECTION_VERSION,collect_runtime,summary

DEP='11111111-1111-4111-8111-111111111111'
RS='22222222-2222-4222-8222-222222222222'
POD='33333333-3333-4333-8333-333333333333'
APP='44444444-4444-4444-8444-444444444444'

def fixture():
    app={'name':'sample','namespace':'sample','project':'services','uid':APP}
    tree={'nodes':[
        {'kind':'Deployment','group':'apps','name':'sample-api','namespace':'sample','uid':DEP,'resourceVersion':'10'},
        {'kind':'ReplicaSet','group':'apps','name':'sample-api-hash','namespace':'sample','uid':RS,'parentRefs':[{'kind':'Deployment','name':'sample-api','uid':DEP}]},
        {'kind':'Pod','name':'sample-api-hash-pod','namespace':'sample','uid':POD,'resourceVersion':'20','parentRefs':[{'kind':'ReplicaSet','name':'sample-api-hash','uid':RS}]},
        {'kind':'Secret','name':'never-read','namespace':'sample','uid':APP},
        {'kind':'Pod','name':'foreign','namespace':'other','uid':APP}]}
    deployment={'kind':'Deployment','metadata':{'name':'sample-api','namespace':'sample','uid':DEP,'resourceVersion':'10'},'spec':{'replicas':2,'template':{'spec':{'containers':[{'env':[{'value':'do-not-store'}]}]}}},'status':{'replicas':2,'readyReplicas':1}}
    pod={'kind':'Pod','metadata':{'name':'sample-api-hash-pod','namespace':'sample','uid':POD,'resourceVersion':'20','ownerReferences':[{'kind':'ReplicaSet','uid':RS,'name':'sample-api-hash'}]},'spec':{'containers':[{'name':'app','image':'example/app@sha256:'+'a'*64,'env':[{'name':'PASSWORD','value':'do-not-store'}]}]},'status':{'phase':'Running','containerStatuses':[{'name':'app','image':'example/app@sha256:'+'a'*64,'imageID':'containerd://sha256:'+'b'*64,'ready':True,'restartCount':3,'state':{'waiting':{'message':'do-not-store'}}}]}}
    calls=[]
    def get(source,path,params=None):
        calls.append((path,params))
        if path.endswith('resource-tree'):return json.dumps(tree).encode(),None
        assert params['kind'] in {'Pod','Deployment'} and params['namespace']=='sample' and params['version']=='v1'
        return json.dumps({'manifest':json.dumps(pod if params['kind']=='Pod' else deployment)}).encode(),None
    return app,get,calls,pod


def test_runtime_uses_exact_uid_and_never_stores_manifests_or_env():
    app,get,calls,_=fixture();snapshots=[]
    result=collect_runtime('argo',app,{},get,lambda:snapshots.append(json.dumps(app)),lambda:1000,200)
    assert len(calls)==3
    assert 'do-not-store' not in json.dumps(result)+''.join(snapshots)
    assert summary(result)['ready']==1 and summary(result)['desired']==2 and summary(result)['restarts']==3
    assert next(o for o in result['objects'] if o['kind']=='Pod')['containers'][0]['image_id'].startswith('containerd://sha256:')


def test_unchanged_resource_versions_need_only_the_tree_request():
    app,get,calls,_=fixture()
    first=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    app.pop('_runtime');calls.clear()
    second=collect_runtime('argo',app,first,get,lambda:None,lambda:1600,200)
    assert len(calls)==1
    assert [{k:v for k,v in obj.items() if k!='checked_at'} for obj in second['objects']]==[{k:v for k,v in obj.items() if k!='checked_at'} for obj in first['objects']]
    assert all(obj['checked_at']==second['observed_at'] for obj in second['objects'])
    assert second['objects'][0]['fetched_at']==first['objects'][0]['fetched_at']


def test_replaced_uid_is_not_misrepresented_as_old_pod():
    app,get,_,pod=fixture();pod['metadata']['uid']=APP
    with pytest.raises(ValueError,match='identity changed'):
        collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)


def test_continuation_resumes_without_repeating_successful_reads():
    from sdm.reconcile import Deferred
    app,get,calls,_=fixture();deferred=[True]
    def limited(source,path,params=None):
        if params and params.get('kind')=='Pod' and deferred[0]:
            deferred[0]=False;raise Deferred(1002)
        return get(source,path,params)
    with pytest.raises(Deferred):collect_runtime('argo',app,{},limited,lambda:None,lambda:1000,200)
    app=json.loads(json.dumps(app))
    result=collect_runtime('argo',app,{},limited,lambda:None,lambda:1002,200)
    assert len(calls)==3 and len(result['objects'])==2


def test_network_projection_keeps_only_routes_selectors_and_native_account_references():
    app,original,calls,_=fixture()
    service_uid='55555555-5555-4555-8555-555555555555'
    ingress_uid='66666666-6666-4666-8666-666666666666'
    service={'kind':'Service','metadata':{'name':'unrelated-name','namespace':'sample','uid':service_uid,'resourceVersion':'30'},
        'spec':{'selector':{'app':'api'},'clusterIP':'do-not-store'}}
    ingress={'kind':'Ingress','metadata':{'name':'entry','namespace':'sample','uid':ingress_uid,'resourceVersion':'40','annotations':{'secret':'do-not-store'}},
        'spec':{'tls':[{'hosts':['*.example.test'],'secretName':'private-certificate'}],
            'rules':[{'host':'api.example.test','http':{'paths':[{'path':'/api','pathType':'Prefix','backend':{'service':{'name':'unrelated-name','port':{'number':80}}}}]}}]}}
    def get(source,path,params=None):
        if params and params.get('kind') in {'Service','Ingress'}:
            calls.append((path,params))
            obj=service if params['kind']=='Service' else ingress
            return json.dumps({'manifest':json.dumps(obj)}).encode(),None
        body,headers=original(source,path,params)
        value=json.loads(body)
        if path.endswith('resource-tree'):
            value['nodes'] += [{'kind':o['kind'],'group':'' if o['kind']=='Service' else 'networking.k8s.io',
                **{key:o['metadata'][key] for key in ['uid','name','namespace','resourceVersion']}} for o in [service,ingress]]
        else:
            obj=json.loads(value['manifest'])
            if obj['kind']=='Deployment':
                obj['spec']['template']['metadata']={'labels':{'app':'api'}}
                obj['spec']['template']['spec']['serviceAccountName']='account'
            if obj['kind']=='Pod':obj['spec']['serviceAccountName']='account'
            value['manifest']=json.dumps(obj)
        return json.dumps(value).encode(),headers
    result=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    assert len(calls)==5
    projected={o['kind']:o for o in result['objects']}
    assert projected['Service']['selector']=={'app':'api'}
    assert projected['Ingress']['routes']==[{'host':'api.example.test','path':'/api','path_type':'Prefix','tls':True,'service_name':'unrelated-name'}]
    assert projected['Deployment']['pod_labels']=={'app':'api'}
    assert projected['Deployment']['service_account']=='account'
    assert {'kind':'ServiceAccount','name':'account','relation':'service account'} in projected['Pod']['references']
    assert 'do-not-store' not in json.dumps(result)
    assert projected['Ingress']['tls_secrets']==['private-certificate']


def test_projection_upgrade_refreshes_once_even_when_resource_version_did_not_change():
    app,get,calls,_=fixture()
    first=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    first['projection_version']=PROJECTION_VERSION-1
    app.pop('_runtime');calls.clear()
    upgraded=collect_runtime('argo',app,first,get,lambda:None,lambda:1600,200)
    assert len(calls)==3
    assert upgraded['projection_version']==PROJECTION_VERSION
    app.pop('_runtime');calls.clear()
    collect_runtime('argo',app,upgraded,get,lambda:None,lambda:2200,200)
    assert len(calls)==1


def test_tree_health_is_kept_without_reading_secret_or_external_secret_manifests():
    app,original,calls,_=fixture()
    def get(source,path,params=None):
        body,headers=original(source,path,params)
        if path.endswith('resource-tree'):
            value=json.loads(body)
            value['nodes'].append({'kind':'ExternalSecret','group':'external-secrets.io','name':'sample-runtime',
                'namespace':'sample','uid':'55555555-5555-4555-8555-555555555555',
                'health':{'status':'Healthy','message':'do-not-store'}})
            value['nodes'][0]['health']={'status':'Progressing'}
            return json.dumps(value).encode(),headers
        return body,headers
    result=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    assert len(calls)==3
    assert next(node for node in result['tree'] if node['kind']=='ExternalSecret')['health']=='Healthy'
    assert next(node for node in result['tree'] if node['kind']=='Deployment')['health']=='Progressing'
    assert 'do-not-store' not in json.dumps(result)
    assert not any(params and params.get('kind') in {'Secret','ExternalSecret'} for _,params in calls)


def test_pod_readiness_and_container_reason_are_facts_without_messages():
    app,get,_,pod=fixture()
    pod['status']['conditions']=[{'type':'Ready','status':'False','reason':'ContainersNotReady','message':'do-not-store'}]
    pod['status']['containerStatuses'][0]['state']={'waiting':{'reason':'CrashLoopBackOff','message':'do-not-store'}}
    pod['status']['initContainerStatuses']=[{'name':'setup','ready':False,'restartCount':1,
        'state':{'terminated':{'reason':'Error','exitCode':17,'message':'do-not-store'}}}]
    result=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    actual=next(obj for obj in result['objects'] if obj['kind']=='Pod')
    assert actual['conditions']==[{'type':'Ready','status':'False','reason':'ContainersNotReady'}]
    assert actual['containers'][0]['state']=='waiting' and actual['containers'][0]['reason']=='CrashLoopBackOff'
    assert actual['containers'][1]['state']=='terminated' and actual['containers'][1]['exit_code']==17
    assert 'do-not-store' not in json.dumps(result)


def test_last_termination_survives_recovery_for_regular_and_init_containers_without_messages():
    app,get,calls,pod=fixture()
    pod['status']['containerStatuses'][0].update(state={'running':{'startedAt':'2026-10-16T09:00:01Z'}},
        lastState={'terminated':{'reason':'OOMKilled','exitCode':137,'finishedAt':'2026-10-16T12:00:00+03:00',
            'message':'do-not-store','containerID':'do-not-store','signal':9}})
    pod['status']['initContainerStatuses']=[{'name':'setup','ready':True,'restartCount':1,
        'state':{'terminated':{'reason':'Completed','exitCode':0}},
        'lastState':{'terminated':{'reason':'Error','exitCode':17,'finishedAt':'2026-10-16T08:59:00Z','message':'do-not-store'}}}]
    result=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    actual=next(obj for obj in result['objects'] if obj['kind']=='Pod')
    assert actual['containers'][0]['state']=='running'
    assert actual['containers'][0]['last_termination']=={'reason':'OOMKilled','exit_code':137,'finished_at':'2026-10-16T09:00:00Z'}
    assert actual['containers'][1]['last_termination']=={'reason':'Error','exit_code':17,'finished_at':'2026-10-16T08:59:00Z'}
    assert len(calls)==3
    assert 'do-not-store' not in json.dumps(result)


@pytest.mark.parametrize('previous',[
    None, [], {'running':{}}, {'terminated':{}}, {'terminated':'do-not-store'},
    {'terminated':{'reason':'do-not-store message','exitCode':'137','finishedAt':'do-not-store','message':'do-not-store'}},
    {'terminated':{'reason':None,'exitCode':True,'finishedAt':'2026-10-16T09:00:00'}},
])
def test_invalid_or_absent_last_termination_does_not_invent_metadata(previous):
    from sdm.runtime import last_termination
    assert last_termination(previous)=={}


def test_projected_mounts_pvc_and_init_images_are_exact_references_without_extra_resource_reads():
    app,get,calls,pod=fixture()
    pod['spec']['volumes']=[
        {'name':'combined','projected':{'sources':[
            {'secret':{'name':'projected-secret','items':[{'key':'do-not-store','path':'do-not-store'}]}},
            {'configMap':{'name':'projected-config','items':[{'key':'do-not-store','path':'do-not-store'}]}},
            {'secret':{'name':'projected-secret'}},
            {'secret':{'name':'invalid/name'}},
            {'serviceAccountToken':{'path':'do-not-store'}},
            {'downwardAPI':{'items':[{'path':'do-not-store'}]}},
        ]}},
        {'name':'storage','persistentVolumeClaim':{'claimName':'existing-storage','readOnly':True}},
    ]
    pod['spec']['initContainers']=[{'name':'prepare','image':'example/setup@sha256:'+'c'*64,
        'env':[{'name':'PRIVATE','value':'do-not-store'}]}]
    pod['spec']['imagePullSecrets']=[{'name':'registry-pull'},{'name':'registry-pull'}]
    result=collect_runtime('argo',app,{},get,lambda:None,lambda:1000,200)
    actual=next(obj for obj in result['objects'] if obj['kind']=='Pod')
    assert actual['references']==[
        {'kind':'Secret','name':'registry-pull','relation':'image pull secret'},
        {'kind':'Secret','name':'projected-secret','relation':'projected mount'},
        {'kind':'ConfigMap','name':'projected-config','relation':'projected mount'},
        {'kind':'PersistentVolumeClaim','name':'existing-storage','relation':'mount'},
    ]
    assert actual['images']==[
        {'name':'app','image':'example/app@sha256:'+'a'*64},
        {'name':'prepare','image':'example/setup@sha256:'+'c'*64,'init':True},
    ]
    assert result['projection_version']==PROJECTION_VERSION
    assert len(calls)==3
    assert not any(params and params.get('kind') in {'Secret','ConfigMap','PersistentVolumeClaim'} for _,params in calls)
    assert 'do-not-store' not in json.dumps(result)


def test_ingress_default_backend_is_an_exact_service_reference_without_invented_routes():
    from sdm.runtime import project_manifest
    node={'kind':'Ingress','group':'networking.k8s.io','namespace':'sample','name':'catchall','uid':APP}
    obj={'kind':'Ingress','metadata':{'name':'catchall','namespace':'sample','uid':APP},
        'spec':{'defaultBackend':{'service':{'name':'actual-service','port':{'number':80}}}}}
    projected=project_manifest(obj,node,'2026-10-16T00:00:00Z')
    assert projected['default_backend_service']=='actual-service'
    assert projected['routes']==[]
    obj['spec']['defaultBackend']['service']['name']='invalid/service'
    assert 'default_backend_service' not in project_manifest(obj,node,'2026-10-16T00:00:00Z')


def test_owner_and_tree_references_preserve_groups_with_exact_uids_without_manifests():
    from sdm.runtime import refs
    references=refs([
        {'uid':DEP,'kind':'Widget','name':'same-name','group':'alpha.example.test','message':'do-not-store'},
        {'uid':RS,'kind':'Widget','name':'same-name','apiVersion':'beta.example.test/v1','controller':True},
        {'uid':POD,'kind':'Pod','name':'api','apiVersion':'v1'},
    ])
    assert references==[
        {'uid':DEP,'kind':'Widget','name':'same-name','group':'alpha.example.test'},
        {'uid':RS,'kind':'Widget','name':'same-name','group':'beta.example.test','controller':True},
        {'uid':POD,'kind':'Pod','name':'api','group':''},
    ]
    assert 'do-not-store' not in json.dumps(references)
