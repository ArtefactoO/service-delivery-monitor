from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import os
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from sdm.contracts import DeliveryEvent, feature_id
from sdm.store import events


def test_credentials_and_producer_scope(client, settings, headers, event):
    payload = event()
    assert client.post("/api/v1/events", json=payload).status_code == 422
    assert client.post("/api/v1/events", json=payload, headers={**headers, "Authorization": "Bearer invalid"}).status_code == 401
    assert client.get("/api/v1/services").status_code == 401
    wrong = {"X-Producer-ID": "build", "Authorization": "Bearer " + os.environ["TEST_BUILD"]}
    assert client.post("/api/v1/events", json=payload, headers=wrong).status_code == 403
    payload["source"]["project_id"] = 999
    assert client.post("/api/v1/events", json=payload, headers=headers).status_code == 403


def test_atomic_idempotency_and_conflicting_replay(client, store, settings, headers, event):
    payload = event()
    response = client.post("/api/v1/events", json=payload, headers=headers)
    assert response.status_code == 202
    assert response.json()["applied"]
    assert client.post("/api/v1/events", json=payload, headers=headers).json()["duplicate"]
    changed = deepcopy(payload); changed["source"]["revision"] = "f" * 40
    assert client.post("/api/v1/events", json=changed, headers=headers).status_code == 409
    with store.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(events)).scalar() == 1


def test_concurrent_duplicate_acceptance(store, settings, event):
    payload = DeliveryEvent.model_validate(event())
    def send(_):
        return store.ingest(payload, "publisher", settings.producers["publisher"], {})
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(send, range(15)))
    assert sum(not item["duplicate"] for item in results) == 1


def test_late_attempt_does_not_rewind_publication(store, settings, event):
    producer = settings.producers["publisher"]
    store.ingest(DeliveryEvent.model_validate(event(pipeline=20)), "publisher", producer, {})
    old = event(pipeline=10); old["publication"]["revision"] = "e" * 40
    result = store.ingest(DeliveryEvent.model_validate(old), "publisher", producer, {})
    assert not result["applied"]
    assert store.service_state("sample")["instances"][0]["desired"]["publication"]["revision"] == "c" * 40
    assert len(store.event_history("sample")) == 2


def test_failure_keeps_previous_verified_and_new_desired(store, settings, event):
    producer = settings.producers["publisher"]
    for payload in [event(kind="deployment", pipeline=10), event(pipeline=20), event(kind="deployment", status="failed", pipeline=20)]:
        store.ingest(DeliveryEvent.model_validate(payload), "publisher", producer, {})
    row = store.service_state("sample")["instances"][0]
    assert row["verified"]["ordering"][0] == 10
    assert row["desired"]["ordering"][0] == 20


def test_build_is_branch_scoped_and_does_not_create_runtime(store, settings, event):
    store.ingest(DeliveryEvent.model_validate(event(kind="build", feature=True)), "build", settings.producers["build"], {})
    assert store.service_state("sample")["instances"] == []
    assert len(store.service_state("sample")["latest_attempts"]) == 1


def test_feature_identity_and_age_survive_redeploy(store, settings, event):
    producer = settings.producers["publisher"]
    first = event(kind="deployment", pipeline=10, feature=True)
    next_event = event(kind="deployment", pipeline=11, feature=True)
    next_event["runtime"]["verified_at"] = "2026-01-03T00:00:00Z"
    next_event["occurred_at"] = "2026-01-03T00:00:00Z"
    for payload in [first, next_event]:
        store.ingest(DeliveryEvent.model_validate(payload), "publisher", producer, {})
    now = datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()
    row = store.service_state("sample", now=now)["instances"][0]
    assert row["lifetime_seconds"] == 3 * 86400
    assert row["lifecycle"]["first_verified_at"].startswith("2026-01-02")
    assert row["verified"]["ordering"][0] == 11
    assert row["name"] == feature_id("sample", "example/sample", "feature/topic")


def test_feature_stop_and_new_incarnation(store, settings, event):
    producer = settings.producers["publisher"]
    start = event(kind="deployment", pipeline=10, feature=True)
    stop = event(kind="deployment", pipeline=11, feature=True, action="delete")
    stop["occurred_at"] = "2026-01-04T00:00:00Z"
    for payload in [start, stop]:
        store.ingest(DeliveryEvent.model_validate(payload), "publisher", producer, {})
    assert len(store.event_history('sample'))==2
    now = datetime(2026, 1, 10, tzinfo=timezone.utc).timestamp()
    assert store.service_state("sample", now)["instances"][0]["lifetime_seconds"] == 3 * 86400
    late = event(kind="deployment", pipeline=10, sequence=5, feature=True)
    assert not store.ingest(DeliveryEvent.model_validate(late), "publisher", producer, {})["applied"]
    new = event(kind="deployment", pipeline=12, feature=True, uid=str(uuid4()))
    new["runtime"].update(application_created_at="2026-01-09T00:00:00Z", verified_at="2026-01-09T01:00:00Z")
    new["occurred_at"] = "2026-01-09T01:00:00Z"
    store.ingest(DeliveryEvent.model_validate(new), "publisher", producer, {})
    row = store.service_state("sample", now)["instances"][0]
    assert row["lifetime_seconds"] == 86400
    assert row["lifecycle"]["stopped_at"] is None
    assert len(store.event_history('sample'))==4


def test_archived_instance_history_is_filtered_before_paging_and_cannot_read_another_service(client, store, settings, event):
    producer=settings.producers['publisher']
    start=event(kind='deployment',feature=True)
    stop=event(kind='deployment',feature=True,action='delete',pipeline=11)
    stop['occurred_at']='2026-01-04T00:00:00Z'
    for payload in [start,stop]:store.ingest(DeliveryEvent.model_validate(payload),'publisher',producer,{})
    for pipeline in range(20,75):store.ingest(DeliveryEvent.model_validate(event(kind='publication',pipeline=pipeline)),'publisher',producer,{})
    headers={'Authorization':'Bearer '+os.environ['TEST_READER']}
    archived=next(item for item in store.service_state('sample')['instances'] if item['environment']=='feature')
    response=client.get('/api/v1/services/sample/events',params={'instance':archived['id'],'limit':1},headers=headers)
    records=response.json()['items']
    assert response.status_code==200 and records[0]['payload']['action']=='delete'
    older=client.get('/api/v1/services/sample/events',params={'instance':archived['id'],'before':records[0]['id']},headers=headers).json()['items']
    assert len(older)==1 and older[0]['payload']['action']=='upsert'
    assert client.get('/api/v1/services/sample/events',params={'instance':'another:feature:unknown'},headers=headers).status_code==404
    assert len(store.event_history('sample'))==50


def test_unconfirmed_creation_age_is_unknown(store, settings, event):
    store.ingest(DeliveryEvent.model_validate(event(feature=True)), "publisher", settings.producers["publisher"], {})
    assert store.service_state("sample")["instances"][0]["lifetime_seconds"] is None


def test_invalid_payload_and_body_limit(client, settings, headers, event):
    payload = event(); payload["target"]["instance"] = "different"
    assert client.post("/api/v1/events", json=payload, headers=headers).status_code == 422
    payload = event(); payload["secret_value"] = "must-not-echo"
    response = client.post("/api/v1/events", json=payload, headers=headers)
    assert response.status_code == 422 and "must-not-echo" not in response.text
    response = client.post("/api/v1/events", content=b"x" * (settings.request_body_bytes + 1), headers=headers)
    assert response.status_code == 413


def test_deleted_registration_rejects_events_but_preserves_history(store, settings, event):
    producer = settings.producers["publisher"]
    store.ingest(DeliveryEvent.model_validate(event()), "publisher", producer, {})
    store.catalog([], "removed", {})
    assert store.list_services() == []
    assert len(store.event_history("sample")) == 1
    from sdm.store import Rejected
    with pytest.raises(Rejected):
        store.ingest(DeliveryEvent.model_validate(event(pipeline=11)), "publisher", producer, {})


def test_terminal_status_cannot_revert_to_running(store, settings, event):
    from sdm.store import Rejected
    producer = settings.producers["publisher"]
    store.ingest(DeliveryEvent.model_validate(event(pipeline=10)), "publisher", producer, {})
    with pytest.raises(Rejected) as rejected:
        store.ingest(DeliveryEvent.model_validate(event(status="started", pipeline=10, sequence=2)), "publisher", producer, {})
    assert rejected.value.code == "terminal_attempt_conflict"


def test_stop_for_old_uid_cannot_stop_new_incarnation(store, settings, event):
    producer = settings.producers["publisher"]
    active = event(kind="deployment", feature=True, pipeline=20, uid=str(uuid4()))
    store.ingest(DeliveryEvent.model_validate(active), "publisher", producer, {})
    stale_stop = event(kind="deployment", feature=True, pipeline=21, action="delete")
    assert not store.ingest(DeliveryEvent.model_validate(stale_stop), "publisher", producer, {})["applied"]
    assert store.service_state("sample")["instances"][0]["lifecycle"]["stopped_at"] is None


def test_feature_names_use_the_full_normalized_branch_and_service():
    assert feature_id("sample", "example/sample", "feature/a_b/c") == "ft-a-b-c-sample"


def test_verified_absence_without_known_uid_is_not_a_fake_application(store,settings,event):
    payload=event(kind='deployment',feature=True,action='delete')
    payload.pop('runtime');payload['absence_confirmed']=True
    result=store.ingest(DeliveryEvent.model_validate(payload),'publisher',settings.producers['publisher'],{})
    assert result['applied'] is False
    assert store.service_state('sample')['instances'] == []
    assert store.event_history('sample')[0]['payload']['absence_confirmed'] is True


def test_old_absence_receipt_cannot_stop_new_feature_incarnation(store,settings,event):
    current=event(kind='deployment',feature=True,pipeline=10,uid='22222222-2222-4222-8222-222222222222')
    current['runtime']['application_created_at']='2026-01-03T00:00:00Z'
    current['runtime']['verified_at']='2026-01-04T00:00:00Z';current['occurred_at']='2026-01-04T00:00:00Z'
    store.ingest(DeliveryEvent.model_validate(current),'publisher',settings.producers['publisher'],{})
    old=event(kind='deployment',feature=True,action='delete',pipeline=11)
    old.pop('runtime');old['absence_confirmed']=True
    assert store.ingest(DeliveryEvent.model_validate(old),'publisher',settings.producers['publisher'],{})['applied'] is False
    assert store.service_state('sample')['instances'][0]['lifecycle']['stopped_at'] is None
