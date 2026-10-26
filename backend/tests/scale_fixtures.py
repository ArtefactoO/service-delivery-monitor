"""Synthetic delivery inventory. No live URLs, credentials or external network."""
import base64
import copy
import hashlib
import json
from collections import defaultdict
from uuid import NAMESPACE_DNS, uuid5

import httpx
from sqlalchemy import select, update

from sdm.config import Integration
from sdm.contracts import expected_instance
from sdm.reconcile import Reconciler, app_snapshot, values_projection
from sdm.runtime import collect_runtime
from sdm.store import application_checks, instances, iso, jobs, repository_trees, value_metadata


def mask_fields(value, mask):
    trie = {}
    for field in mask.split(','):
        node = trie
        for part in field.split('.'):
            node = node.setdefault(part, {})
    def project(value, branch):
        if not branch:
            return value
        if isinstance(value, list):
            return [project(item, branch) for item in value]
        if not isinstance(value, dict):
            return {}
        return {key: project(value[key], child) for key, child in branch.items() if key in value}
    return project(value, trie)


class Inventory:
    def __init__(self, store, settings, count=3, features=False, warm=True, now=2_000_000_000.0, latency_seconds=0):
        self.store, self.settings, self.now = store, settings, [now]
        self.latency_seconds = latency_seconds
        self.calls, self.apps, self.files, self.runtime = [], defaultdict(list), {}, {}
        self.revision = 'c' * 40
        self.registrations = [{'key':f'svc-{i:03}', 'project_id':1000+i, 'project':f'example/svc-{i:03}', 'test_ref':'dev'} for i in range(count)]
        store.catalog(self.registrations, 'fixture', {})
        settings.integrations = {'git':Integration(kind='gitlab',base_url='https://git.example',token_env='TEST_GITLAB',project_id=900),
            **{name:Integration(kind='argocd',base_url=f'https://{name}.example',token_env='TEST_ARGO',projects=[name],
                environments=['test','feature'] if name=='argo-test' else ['prod'],
                deployment_repo_url='https://git.example/deployments.git',gitlab_source='git',runtime_enabled=True,
                requests_per_window=120) for name in ['argo-test','argo-prod']}}
        for registration in self.registrations:
            for env in ['test','prod',*(['feature'] if features else [])]:
                self.add(registration, env, warm)
        self.transport = httpx.MockTransport(self.handle)
        self.worker = Reconciler(store, settings, httpx.Client(transport=self.transport),clock=lambda:self.now[0],jitter=lambda *_:0)
        self.worker.bootstrap()
        if warm:
            self.seed_tree()

    def add(self, registration, environment, warm):
        source = 'argo-prod' if environment=='prod' else 'argo-test'
        ref = 'feature/topic' if environment=='feature' else 'dev'
        name = expected_instance(registration['key'],registration['project'],environment,ref)
        namespace = registration['key']
        uid = lambda kind:str(uuid5(NAMESPACE_DNS,source+'/'+name+'/'+kind))
        path = f'kubernetes/{environment}/{name}/values.yaml'
        annotations = {'delivery.example.com/source-project':registration['project'], 'delivery.example.com/source-ref':ref,
            'delivery.example.com/source-revision':'a'*40, 'delivery.example.com/build-source-revision':'a'*40,
            'delivery.example.com/config-project':f'example-config/{environment}-configs'}
        content = json.dumps({'namespace':namespace,'deployments':{'api':{'annotations':annotations,
            'image':{'repository':f'registry.example/{namespace}','digest':'sha256:'+'b'*64},
            'config':{'files':{'app.yaml':'NEVER-PERSIST-CONFIG-CONTENT'}}}}}).encode()
        blob = hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
        self.files[path] = {'content':content,'blob':blob}
        raw = {'metadata':{'name':name,'uid':uid('Application'),'creationTimestamp':'2026-01-01T00:00:00Z'},
            'spec':{'project':source,'destination':{'namespace':namespace},'sources':[
                {'repoURL':'https://git.example/chart.git','targetRevision':'v1.0.0','helm':{
                    'valueFiles':['$values/'+path],'values':'NEVER-PERSIST-INLINE-VALUES'}},
                {'repoURL':'https://git.example/deployments.git','targetRevision':'main','ref':'values'}]},
            'status':{'sync':{'status':'Synced','revisions':['a'*40,self.revision]},'health':{'status':'Healthy'},
                'resources':[],'history':[{'unneeded':'x'*20000}]}}
        self.apps[source].append(raw)
        tree, manifests = [], {}
        for kind in ['Deployment','Pod','Secret']:
            node = {'name':name+'-api','namespace':namespace,'uid':uid(kind),'kind':kind,'group':'apps' if kind=='Deployment' else '',
                'version':'v1','resourceVersion':'10','health':{'status':'Healthy'}}
            tree.append(node)
            manifests[kind] = {'kind':kind,'metadata':{k:node[k] for k in ('name','namespace','uid','resourceVersion')},
                'spec':{'replicas':1,'containers':[{'name':'app','image':'example/app@sha256:'+'b'*64,
                    'env':[{'name':'PASSWORD','value':'NEVER-PERSIST-ENV'}]}]},
                'status':{'readyReplicas':1,'phase':'Running','containerStatuses':[{'name':'app','imageID':'containerd://sha256:'+'b'*64,
                    'ready':True,'restartCount':0,'state':{'running':{}}}]}}
        self.runtime[(source,name)] = {'tree':{'nodes':tree},'manifests':manifests}
        if warm:
            snapshot = app_snapshot(raw,self.settings.integrations[source])
            runtime = collect_runtime(source,dict(snapshot),{},lambda n,p,params=None:self.runtime_get(source,name,p,params),
                lambda:None,lambda:self.now[0]-700,200)
            with self.store.engine.begin() as conn:
                conn.execute(instances.insert().values(id=f"{registration['key']}:{environment}:{name}",service=registration['key'],
                    environment=environment,name=name,source_ref=ref,desired=None,verified=None,updated_at=self.now[0]-700,
                    lifecycle={'application_uid':uid('Application'),'created_at':'2026-01-01T00:00:00Z'},
                    observations={source:{**snapshot,'git':values_projection(content),'values_blob':blob,'runtime':runtime,
                        'present':True,'observed_at':iso(self.now[0]-700),'presence_checked_at':iso(self.now[0]-700)}}))

    def seed_tree(self):
        from sdm.delivery_versions import remember
        for service in self.registrations:
            remember(self.worker, 'git', 'ci-pin', [service['project'], 'a'*40], complete=True, value=None)
        with self.store.engine.begin() as conn:
            conn.execute(repository_trees.insert().values(source='git',project_id=900,revision=self.revision,
                files={p:f['blob'] for p,f in self.files.items()},complete=True,used_at=self.now[0]))
            seen = set()
            for file in self.files.values():
                if file['blob'] in seen:continue
                seen.add(file['blob'])
                conn.execute(value_metadata.insert().values(source='git',project_id=900,blob=file['blob'],
                    projection=values_projection(file['content']),used_at=self.now[0]))

    def runtime_get(self, source, name, path, params):
        data = self.runtime[(source,name)]
        if path.endswith('/resource-tree'):
            return json.dumps(data['tree']).encode(),None
        assert params['kind'] in {'Deployment','Pod'}, 'Secret manifests must never be requested'
        return json.dumps({'manifest':json.dumps(data['manifests'][params['kind']])}).encode(),None

    def handle(self, request):
        host, path, params = request.url.host, request.url.path, request.url.params
        source = host.removesuffix('.example')
        self.calls.append({'at':self.now[0],'source':source,'path':path,'params':dict(params)})
        self.now[0] += self.latency_seconds
        if source in self.apps:
            if path=='/api/v1/applications':
                assert params.get_list('projects')==[source]
                assert 'fields' not in params
                return httpx.Response(200,json={'items':self.apps[source]})
            body,_=self.runtime_get(source,path.split('/')[4],path,dict(params))
            return httpx.Response(200,content=body)
        assert source=='git'
        if path.endswith('/repository/tree'):
            if params.get('recursive')=='true':
                entries = [{'type':'blob','path':p,'id':v['blob']} for p,v in sorted(self.files.items())]
                offset=(int(params['page'])-1)*100
                return httpx.Response(200,json=entries[offset:offset+100])
            return httpx.Response(200,json=[{'name':e,'type':'tree','path':'kubernetes/'+e} for e in ['test','prod','feature']])
        if path.endswith('/raw'):
            from urllib.parse import unquote
            file=unquote(path.split('/repository/files/')[1].removesuffix('/raw'))
            if file=='.gitlab-ci.yml':
                return httpx.Response(200,content=b'include: []')
            return httpx.Response(200,content=self.files[file]['content'])
        if request.headers.get('If-None-Match')=='same':
            return httpx.Response(304)
        registry='SERVICES = '+repr({r['key']:{k:v for k,v in r.items() if k!='key'} for r in self.registrations})
        return httpx.Response(200,json={'content':base64.b64encode(registry.encode()).decode(),'last_commit_id':'a'*40},headers={'ETag':'same'})

    def step(self):
        worked = self.worker.tick()
        self.now[0] += .05 if worked else 1
        return worked

    def close(self):
        self.worker.client.close()
