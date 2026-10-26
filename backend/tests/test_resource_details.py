import json
import pytest
import yaml
from sdm.reconcile import values_projection


def values():
 return {'deployments':{'api':{'annotations':{'delivery.example.com/source-project':'team/app','delivery.example.com/source-ref':'dev','delivery.example.com/source-revision':'a'*40,'delivery.example.com/config-managed-files':'["app.yaml"]'},'externalSecret':{'enabled':True,'data':[{'remoteRef':{'key':'shared/path','property':'username'}},{'remoteRef':{'key':'shared/path'}}],'dataFrom':[{'extract':{'key':'shared/path'}}]}}}}


def test_projection_preserves_selection_modes_and_external_filename_proof_without_values():
 payload=values();payload['deployments']['api']['externalSecret']['data'][0]['remoteRef']['unexpected']='must-not-store'
 result=values_projection(yaml.safe_dump(payload).encode())
 assert result['config_managed_files']==['app.yaml']
 refs=result['workloads'][0]['external_secret']['remote_refs']
 assert refs==[{'key':'shared/path','property':'username','mode':'property'},{'key':'shared/path','mode':'value'},{'key':'shared/path','mode':'extract'}]
 assert 'must-not-store' not in json.dumps(result)


@pytest.mark.parametrize('recorded',['["../app.yaml"]','{"file":"app.yaml"}','[false]'])
def test_external_filename_proof_rejects_paths_and_invalid_shapes(recorded):
 payload=values();payload['deployments']['api']['annotations']['delivery.example.com/config-managed-files']=recorded
 with pytest.raises(ValueError):values_projection(yaml.safe_dump(payload).encode())
