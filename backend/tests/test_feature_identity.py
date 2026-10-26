"""Feature names never replace the complete source identity used for ownership."""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import re

import httpx
import pytest
from sqlalchemy import select

from sdm.config import Integration
from sdm.contracts import DeliveryEvent, feature_id, matches_instance
from sdm.reconcile import Reconciler
from sdm.store import Rejected, instances, streams, target_id
from test_argo_notifications import auth, notification, notifications


def previous_name(ref, service="sample", project="example/sample"):
    slug = re.sub(r"[^a-z0-9]+", "-", ref.lower()).strip("-")
    return f"ft-{service[:18].rstrip('-')}-{slug[:15].rstrip('-')}-{sha256((project + chr(0) + ref).encode()).hexdigest()[:8]}"


def payload(make, ref, name=None, service="sample", project_id=100, **options):
    body = make(feature=True, **options)
    name = name or feature_id(service, "example/" + service, ref)
    body["service"] = service
    body["source"].update(project_id=project_id, ref=ref)
    body["target"]["instance"] = name
    if body.get("publication"):
        body["publication"]["values_path"] = f"kubernetes/feature/{name}/values.yaml"
    if body.get("runtime"):
        body["runtime"]["application"] = name
    return DeliveryEvent.model_validate(body)


def receive(store, settings, body):
    return store.ingest(body, "publisher", settings.producers["publisher"], {})


def test_full_branch_is_preserved_and_only_service_is_shortened():
    ref = "feature/SL-123456-long_branch.with/nested-part"
    slug = "ft-sl-123456-long-branch-with-nested-part"
    name = feature_id("sample-long-service", "example/sample", ref)
    assert name == slug + "-sample"
    assert len(name) == 48
    assert feature_id("sample", "example/sample", "feature/" + "x" * 44) == "ft-" + "x" * 44 + "-s"
    with pytest.raises(ValueError, match="no space"):
        feature_id("sample", "example/sample", "feature/" + "x" * 45)
    with pytest.raises(ValueError, match="feature target"):
        feature_id("sample", "example/sample", "ft/topic")


def test_only_exact_current_or_previous_names_are_accepted():
    ref = "feature/SL-123456-long_branch"
    old = previous_name(ref)
    assert matches_instance("sample", "example/sample", "feature", ref, old)
    assert matches_instance("sample", "example/sample", "feature", ref, feature_id("sample", "example/sample", ref))
    assert not matches_instance("sample", "another/sample", "feature", ref, old)
    assert not matches_instance("sample", "example/sample", "feature", ref + "-other", old)
    assert not matches_instance("sample", "example/sample", "feature", ref, "ft-anything-12345678")
    long_ref = "feature/" + "x" * 90
    assert matches_instance("sample", "example/sample", "feature", long_ref, previous_name(long_ref))


@pytest.mark.parametrize("old", [False, True])
def test_existing_feature_keeps_recorded_name_through_update_and_stop(store, settings, event, old):
    ref = "feature/topic"
    name = previous_name(ref) if old else feature_id("sample", "example/sample", ref)
    receive(store, settings, payload(event, ref, name, pipeline=10, kind="deployment"))
    receive(store, settings, payload(event, ref, name, pipeline=11, kind="deployment"))
    receive(store, settings, payload(event, ref, name, pipeline=12, kind="deployment", action="delete"))
    row = store.service_state("sample")["instances"][0]
    assert row["name"] == name and row["source_ref"] == ref
    assert row["lifecycle"]["stopped_at"]


@pytest.mark.parametrize("kind,status,pipeline", [("publication", "started", 1), ("publication", "failed", 99),
                                                  ("deployment", "succeeded", 100)])
def test_normalization_collision_cannot_rebind_a_confirmed_name(store, settings, event, kind, status, pipeline):
    receive(store, settings, payload(event, "feature/a_b", kind="deployment", pipeline=20))
    before = deepcopy(store.service_state("sample", now=2_000_000_000)["instances"])
    with pytest.raises(Rejected, match="instance_identity_mismatch"):
        receive(store, settings, payload(event, "feature/a-b", kind=kind, status=status, pipeline=pipeline))
    assert store.service_state("sample", now=2_000_000_000)["instances"] == before


def test_service_truncation_collision_is_rejected_across_projects(store, settings, event):
    store.catalog([{"key": service, "project_id": ident, "project": "example/" + service}
                   for ident, service in ((101, "shared-a"), (102, "shared-b"))], "fixture", {})
    ref = "feature/" + "x" * 39
    assert feature_id("shared-a", "example/shared-a", ref) == feature_id("shared-b", "example/shared-b", ref)
    receive(store, settings, payload(event, ref, service="shared-a", project_id=101, pipeline=10))
    with pytest.raises(Rejected, match="instance_identity_mismatch"):
        receive(store, settings, payload(event, ref, service="shared-b", project_id=102, pipeline=20))
    assert store.service_state("shared-b")["instances"] == []


def test_failed_unpublished_attempt_does_not_reserve_or_order_another_branches_name(store, settings, event):
    failed = payload(event, "feature/a_b", status="failed", pipeline=999)
    assert receive(store, settings, failed)["applied"] is False
    assert store.service_state("sample")["instances"] == []
    with store.engine.connect() as conn:
        assert conn.execute(select(streams)).first() is None
    assert receive(store, settings, payload(event, "feature/a-b", pipeline=10))["applied"] is True
    assert store.service_state("sample")["instances"][0]["source_ref"] == "feature/a-b"
    assert len(store.event_history("sample")) == 2


def test_noop_delete_without_runtime_does_not_reserve_an_unknown_feature_name(store, settings, event):
    body = payload(event, "feature/a_b", kind="deployment", action="delete", pipeline=999).model_dump(mode="json")
    body.pop("runtime")
    body["absence_confirmed"] = True
    assert receive(store, settings, DeliveryEvent.model_validate(body))["applied"] is False
    assert store.service_state("sample")["instances"] == []
    assert receive(store, settings, payload(event, "feature/a-b", pipeline=10))["applied"] is True


def test_previous_provisional_instance_and_order_are_replaced_without_rewriting_history(store, settings, event):
    failed = payload(event, "feature/a_b", status="failed", pipeline=999)
    receive(store, settings, failed)
    key = target_id("sample", "feature", failed.target.instance)
    with store.engine.begin() as conn:
        conn.execute(instances.insert().values(id=key, service="sample", environment="feature", name=failed.target.instance,
            source_ref="feature/a_b", lifecycle={}, observations={}, desired=None, verified=None, updated_at=1000))
        conn.execute(streams.insert().values(key=key + ":publication", service="sample", issuer_project=900,
            ordering=[999, 9990, 1], payload=failed.model_dump(mode="json"), received_at=1000))
    history = deepcopy(store.event_history("sample"))
    assert receive(store, settings, payload(event, "feature/a-b", pipeline=10))["applied"] is True
    row = store.service_state("sample")["instances"][0]
    assert row["source_ref"] == "feature/a-b"
    assert row["desired"]["ordering"][0] == 10
    assert [receipt for receipt in store.event_history("sample") if receipt["id"] == history[0]["id"]] == history


@pytest.mark.parametrize("old", [False, True])
def test_notifications_accept_both_exact_formats_but_cannot_rebind_owner(notifications, notification, store, settings, event, old):
    ref = "feature/a_b"
    name = previous_name(ref) if old else feature_id("sample", "example/sample", ref)
    body = {**notification, "environment": "feature", "source_ref": ref, "application": name,
            "values_path": f"kubernetes/feature/{name}/values.yaml"}
    assert notifications[0].post("/api/v1/argocd/events", headers=auth(), json=body).status_code == 202
    assert store.service_state("sample")["instances"] == []
    receive(store, settings, payload(event, ref, name, pipeline=10))
    conflict = {**body, "source_ref": "feature/a-b", "resource_version": "999"}
    assert notifications[0].post("/api/v1/argocd/events", headers=auth(), json=conflict).status_code == 422


def test_exact_notification_retry_is_idempotent_after_another_ref_claims_the_name(notifications, notification, store, settings, event):
    ref = "feature/a_b"
    name = feature_id("sample", "example/sample", ref)
    body = {**notification, "environment": "feature", "source_ref": ref, "application": name,
            "values_path": f"kubernetes/feature/{name}/values.yaml"}
    client = notifications[0]
    first = client.post("/api/v1/argocd/events", headers=auth(), json=body)
    assert first.status_code == 202
    receive(store, settings, payload(event, "feature/a-b", pipeline=10))
    retried = client.post("/api/v1/argocd/events", headers=auth(), json=body)
    assert retried.status_code == 202
    assert retried.json() == {**first.json(), "duplicate": True}
    modified = client.post("/api/v1/argocd/events", headers=auth(), json={**body, "health": "Healthy"})
    assert modified.status_code == 409
    assert modified.json()["error"] == "event_id_conflict"


@pytest.mark.parametrize("old", [False, True])
@pytest.mark.parametrize("provisional", [False, True])
def test_cold_discovery_tracks_exact_name_and_rejects_rebinding(store, settings, drain_checks, old, provisional):
    ref = "feature/a_b"
    name = previous_name(ref) if old else feature_id("sample", "example/sample", ref)
    settings.integrations = {
        "git": Integration(kind="gitlab", base_url="https://git.example", token_env="TEST_GITLAB", project_id=900),
        "argo": Integration(kind="argocd", base_url="https://argo.example", token_env="TEST_ARGO", projects=["services"],
            environments=["feature"], deployment_repo_url="https://git.example/deployments.git", gitlab_source="git"),
    }
    now = [datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp()]
    app = {"metadata": {"name": name, "uid": "11111111-1111-4111-8111-111111111111", "creationTimestamp": "2026-01-01T00:00:00Z"},
        "spec": {"project": "services", "destination": {"namespace": "sample"}, "sources": [
            {"repoURL": "https://git.example/chart.git", "targetRevision": "v1.0.0", "helm": {"valueFiles": [f"$values/kubernetes/feature/{name}/values.yaml"]}},
            {"repoURL": "https://git.example/deployments.git", "ref": "values", "targetRevision": "main"}]},
        "status": {"sync": {"status": "Synced", "revisions": ["b" * 40, "c" * 40]}, "health": {"status": "Healthy"}, "resources": []}}
    values = {"namespace": "sample", "releaseName": name, "deployments": {"app": {"annotations": {
        "delivery.example.com/source-project": "example/sample", "delivery.example.com/source-ref": ref,
        "delivery.example.com/source-revision": "a" * 40}}}}
    blob = ["e" * 40]
    def handle(request):
        if request.url.host == "argo.example":
            return httpx.Response(200, json={"items": [app]})
        if request.url.path.endswith("/repository/tree"):
            return httpx.Response(200, json=[{"type": "blob", "path": f"kubernetes/feature/{name}/values.yaml", "id": blob[0]}])
        return httpx.Response(200, content=json.dumps(values))
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        worker = Reconciler(store, settings, client, clock=lambda: now[0], jitter=lambda *_: 0)
        with store.engine.begin() as conn:
            for source in settings.integrations:
                store.ensure_source(conn, source)
            if provisional:
                conn.execute(instances.insert().values(id=target_id("sample", "feature", name), service="sample",
                    environment="feature", name=name, source_ref=ref, desired=None, verified=None,
                    lifecycle={"stopped_at": "2026-01-05T00:00:00Z"}, observations={}, updated_at=1000))
        worker.argo("argo")
        drain_checks(worker)
        row = deepcopy(store.service_state("sample")["instances"][0])
        assert row["name"] == name and row["source_ref"] == ref
        assert row["lifecycle"]["application_uid"] == app["metadata"]["uid"]
        assert row["lifecycle"]["stopped_at"] is None
        values["deployments"]["app"]["annotations"]["delivery.example.com/source-ref"] = "feature/a-b"
        app["status"]["sync"]["revisions"][1] = "d" * 40
        blob[0] = "f" * 40
        now[0] += 601
        worker.argo("argo")
        drain_checks(worker)
        current = store.service_state("sample")["instances"][0]
        assert current["source_ref"] == ref
        assert current["observations"]["argo"]["git"]["source_ref"] == ref
