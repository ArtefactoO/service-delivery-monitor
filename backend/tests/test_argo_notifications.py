"""Native Argo identity must never impersonate a GitLab job or confirm runtime."""
import copy
import json
import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update

from sdm.api import create_app
from sdm.argo_notifications import ArgoNotification, ingest
from sdm.config import Integration
from sdm.contracts import DeliveryEvent, feature_id
from sdm.reconcile import Deferred, Reconciler
from sdm.store import application_checks, events, jobs, sources

PATH = "/api/v1/argocd/events"


@pytest.fixture
def notifications(settings, store, monkeypatch):
    monkeypatch.setenv("TEST_ARGO_NOTIFY", "test-notification-credential-" * 3)
    monkeypatch.setenv("PROD_ARGO_NOTIFY", "prod-notification-credential-" * 3)
    settings.integrations = {
        "argo-test": Integration(kind="argocd", base_url="https://argo-test.example", token_env="TEST_ARGO",
            notification_token_env="TEST_ARGO_NOTIFY", projects=["test-services"], environments=["test", "feature"],
            deployment_repo_url="https://git.example/deployments.git"),
        "argo-prod": Integration(kind="argocd", base_url="https://argo-prod.example", token_env="TEST_ARGO",
            notification_token_env="PROD_ARGO_NOTIFY", projects=["prod-services"], environments=["prod"],
            deployment_repo_url="https://git.example/deployments.git"),
    }
    with TestClient(create_app(settings, store)) as client:
        yield client, settings.integrations["argo-test"]


@pytest.fixture
def notification():
    return {"schema_version": 1, "source": "argo-test", "event": "health_changed", "project": "test-services",
        "application": "sample", "application_uid": "11111111-1111-4111-8111-111111111111",
        "application_created_at": "2026-01-01T00:00:00Z", "resource_version": "12345", "namespace": "sample",
        "environment": "test", "source_project": "example/sample", "source_ref": "dev",
        "values_path": "kubernetes/test/sample/values.yaml", "health": "Degraded", "sync": "Synced",
        "revisions": ["a" * 40, "b" * 40]}


def auth(token="TEST_ARGO_NOTIFY", source="argo-test"):
    return {"X-Argo-Source": source, "Authorization": "Bearer " + os.environ[token]}


def test_notification_is_history_and_a_coalesced_signal_without_runtime_writes(notifications, store, notification):
    client, integration = notifications
    now = time.time()
    with store.engine.begin() as conn:
        store.ensure_source(conn, "argo-test")
        conn.execute(update(sources).where(sources.c.name == "argo-test").values(last_success_at=now,
            window_start=now - 10, window_count=29, next_request_at=now + 90, failures=3, backoff_until=now + 180))
    first = client.post(PATH, headers=auth(), json=notification)
    assert first.status_code == 202
    assert first.json()["applied"] is False
    assert first.json()["duplicate"] is False
    assert store.service_state("sample")["instances"] == []
    with store.engine.connect() as conn:
        source = conn.execute(select(sources).where(sources.c.name == "argo-test")).mappings().one()
        job = conn.execute(select(jobs).where(jobs.c.name == "argo-test")).mappings().one()
        assert source["window_count"] == 29
        assert source["next_request_at"] == now + 90
        assert source["backoff_until"] == now + 180
        assert source["failures"] == 3
        assert job["due_at"] == pytest.approx(now + 60, abs=1)
    history = store.event_history("sample")
    assert history[0]["kind"] == "argocd_notification"
    assert "attempt" not in history[0]["payload"]
    assert history[0]["payload"]["revisions"] == notification["revisions"]
    second = client.post(PATH, headers=auth(), json=notification)
    assert second.status_code == 202
    assert second.json() == {**first.json(), "duplicate": True}
    assert len(store.event_history("sample")) == 1
    with store.engine.begin() as conn:
        conn.execute(delete(jobs))
    client.post(PATH, headers=auth(), json=notification)
    with store.engine.connect() as conn:
        assert conn.execute(select(jobs)).first() is None  # retries cannot repeatedly wake the worker


def test_duplicate_identity_cannot_change_payload(notifications, notification):
    client, _ = notifications
    assert client.post(PATH, headers=auth(), json=notification).status_code == 202
    modified = {**notification, "health": "Healthy"}
    result = client.post(PATH, headers=auth(), json=modified)
    assert result.status_code == 409
    assert result.json()["error"] == "event_id_conflict"


@pytest.mark.parametrize("headers", [None, {"X-Argo-Source": "unknown"}, {"X-Argo-Source": "argo-test"}])
def test_unauthenticated_requests_rejected(notifications, notification, headers):
    result = notifications[0].post(PATH, headers=headers, json=notification)
    assert result.status_code in (401, 422)


@pytest.mark.parametrize("token", ["TEST_READER", "TEST_PUBLISHER", "TEST_BUILD", "TEST_ARGO", "PROD_ARGO_NOTIFY"])
def test_other_credentials_do_not_authorize_test_notifications(notifications, notification, token):
    assert notifications[0].post(PATH, headers=auth(token), json=notification).status_code == 401


def test_endpoint_is_machine_only_and_post_only(notifications, notification):
    client, _ = notifications
    assert client.get(PATH, headers=auth()).status_code == 405
    assert client.post(PATH + "/extra", headers=auth(), json=notification).status_code == 404
    assert client.post(PATH, headers={"X-Argo-Source": "argo-test"}, cookies={"sdm_session": "fake"}, json=notification).status_code == 401


@pytest.mark.parametrize("change,status", [
    ({"source": "argo-prod"}, 403), ({"project": "foreign-project"}, 403),
    ({"environment": "prod", "values_path": "kubernetes/prod/sample/values.yaml"}, 403),
    ({"source_project": "example/unregistered"}, 403), ({"application": "foreign", "values_path": "kubernetes/test/foreign/values.yaml"}, 422),
    ({"values_path": "kubernetes/test/foreign/values.yaml"}, 422),
    ({"application_created_at": "2099-01-01T00:00:00Z"}, 422),
    ({"operation_started_at": "2025-01-01T00:00:00Z"}, 422),
    ({"event": "sync_succeeded"}, 422), ({"event": "deleting"}, 422),
    ({"spec": {"secret": "never-store-this"}}, 422), ({"health": "token-injected"}, 422),
    ({"resource_version": "\nprivate"}, 422), ({"revisions": ["https://name:credential@example/path"]}, 422),
])
def test_scope_and_metadata_contract(notifications, notification, store, change, status):
    result = notifications[0].post(PATH, headers=auth(), json={**notification, **change})
    assert result.status_code == status
    assert "never-store-this" not in result.text
    assert store.event_history("sample") == []


def test_feature_binding_uses_full_source_ref(notifications, notification, store):
    client, _ = notifications
    ref = "feature/SL-123"
    application = feature_id("sample", "example/sample", ref)
    payload = {**notification, "environment": "feature", "source_ref": ref, "application": application,
        "values_path": f"kubernetes/feature/{application}/values.yaml"}
    assert client.post(PATH, headers=auth(), json=payload).status_code == 202
    assert store.event_history("sample")[0]["instance_id"] == f"sample:feature:{application}"
    assert client.post(PATH, headers=auth(), json={**payload, "source_ref": "feature/other", "resource_version": "12346"}).status_code == 422
    assert client.post(PATH, headers=auth(), json={**payload, "source_ref": "dev", "resource_version": "12347"}).status_code == 422


def test_old_and_reordered_notifications_do_not_rewind_confirmed_state(notifications, store, notification, settings, event):
    confirmed = event(kind="deployment")
    store.ingest(DeliveryEvent.model_validate(confirmed), "publisher", settings.producers["publisher"], settings.integrations)
    snapshot_at = time.time()
    before = copy.deepcopy(store.service_state("sample", now=snapshot_at)["instances"])
    client, _ = notifications
    for rv, kind in [("20", "sync_succeeded"), ("10", "sync_running"), ("5", "deleting")]:
        payload = {**notification, "resource_version": rv, "event": kind,
            "application_uid": "22222222-2222-4222-8222-222222222222",
            "operation_started_at": "2026-01-02T00:00:00Z", "deletion_started_at": "2026-01-03T00:00:00Z"}
        assert client.post(PATH, headers=auth(), json=payload).status_code == 202
    assert store.service_state("sample", now=snapshot_at)["instances"] == before
    assert len(store.event_history("sample")) == 4


def test_receiver_never_calls_upstream_or_resets_reconcile_budget(notifications, monkeypatch, notification, store):
    def forbidden(*args, **kwargs):
        pytest.fail("notification handler must not call upstream")
    monkeypatch.setattr(httpx.Client, "request", forbidden)
    integration = notifications[1]
    for number in range(20):
        ingest(store, ArgoNotification.model_validate({**notification, "resource_version": str(number)}), "argo-test", integration, now=2_000_000_000 + number)
    with store.engine.connect() as conn:
        job = conn.execute(select(jobs)).mappings().one()
        assert job["due_at"] == 2_000_000_015
        assert job["generation"] == 20
        source = conn.execute(select(sources)).mappings().all()
        assert all(row["window_count"] == 0 for row in source)


def test_monitor_history_and_schema_stay_reader_protected(notifications):
    client, _ = notifications
    assert client.get("/api/v1/schema/argocd-notification").status_code == 401
    schema = client.get("/api/v1/schema/argocd-notification", headers={"Authorization": "Bearer " + os.environ["TEST_READER"]})
    assert schema.status_code == 200
    assert schema.json()["additionalProperties"] is False


@pytest.mark.parametrize("signal", ["native", "publisher"])
def test_signal_during_reconcile_keeps_generation_and_waits_after_success(notifications, store, settings, notification, event, signal):
    now = [2_000_000_000.0]
    config = settings.integrations["argo-test"]
    settings.integrations = {"argo-test": config}
    worker = Reconciler(store, settings, clock=lambda: now[0], jitter=lambda *_: 0)
    worker.bootstrap()
    with store.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.name == "argo-test").values(last_success_at=now[0] - 100,
            window_count=29, window_start=now[0], next_request_at=now[0] + 2))
    calls = []
    def collect(name):
        calls.append(name)
        if len(calls) == 1:
            now[0] += 10
            if signal == "native":
                ingest(store, ArgoNotification.model_validate(notification), name, config, now=now[0])
            else:
                store.ingest(DeliveryEvent.model_validate(event(kind="argocd")), "publisher",
                    settings.producers["publisher"], settings.integrations, now=now[0])
            now[0] += 2
    worker.argo = collect
    now[0] += 2  # Respect the already-reserved spacing slot before selecting work.
    assert worker.tick()
    with store.engine.connect() as conn:
        job = conn.execute(select(jobs)).mappings().one()
        source = conn.execute(select(sources).where(sources.c.name == "argo-test")).mappings().one()
    assert job["generation"] == 1
    assert job["due_at"] == now[0] + 60
    assert source["last_success_at"] == now[0]
    assert source["window_count"] == 29
    assert source["next_request_at"] == 2_000_000_002
    now[0] += 59
    assert not worker.tick()
    now[0] += 1
    assert worker.tick()
    assert len(calls) == 2


def test_signal_during_budget_continuation_survives_until_a_fresh_application_list(notifications, store, settings, notification):
    now = [2_000_000_000.0]
    config = settings.integrations["argo-test"].model_copy(update={"gitlab_source": "git"})
    settings.integrations = {"argo-test": config, "git": Integration(kind="gitlab", base_url="https://git.example",
        token_env="TEST_GITLAB", project_id=900)}
    app = {"metadata": {"name": "sample", "uid": notification["application_uid"],
            "creationTimestamp": notification["application_created_at"]},
        "spec": {"project": "test-services", "destination": {"namespace": "sample"}, "sources": [
            {"repoURL": "https://git.example/chart.git", "helm": {"valueFiles": ["$values/kubernetes/test/sample/values.yaml"]}},
            {"repoURL": config.deployment_repo_url, "ref": "values", "targetRevision": "main"}]},
        "status": {"sync": {"status": "Synced", "revisions": ["a" * 40, "b" * 40]}, "health": {"status": "Healthy"}}}
    values = b"""namespace: sample
deployments:
  arbitrary-component:
    annotations:
      delivery.example.com/source-project: example/sample
      delivery.example.com/source-ref: dev
      delivery.example.com/source-revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
"""
    calls, deferred = [], [False]
    def fetch(name, path, **kwargs):
        calls.append((name, path))
        if name == "argo-test":
            return json.dumps({"items": [app]}).encode(), None
        if not deferred[0]:
            deferred[0] = True
            raise Deferred(now[0] + 10)
        if path.endswith('/repository/tree'):
            return json.dumps([{'type':'blob','path':'kubernetes/test/sample/values.yaml','id':'e'*40}]).encode(), None
        return values, None
    worker = Reconciler(store, settings, clock=lambda: now[0], jitter=lambda *_: 0)
    worker.get = fetch
    worker.bootstrap()
    with store.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.name == "git").values(due_at=now[0] + 10_000))
        conn.execute(update(sources).where(sources.c.name == "argo-test").values(window_count=29,
            window_start=now[0], next_request_at=now[0] + 2))
    assert not worker.tick()  # Preserve the existing per-origin spacing reservation.
    now[0] += 2
    inventory_at = now[0]
    assert worker.tick()  # Discovery enqueues independent checks.
    assert worker.tick()  # Immutable metadata is deferred, without discarding the check.
    with store.engine.connect() as conn:
        pending = conn.execute(select(application_checks)).mappings().one()
    assert pending['snapshot']['name'] == 'sample' and pending['last_success_at'] is None
    now[0] += 1
    ingest(store, ArgoNotification.model_validate(notification), "argo-test", config, now=now[0])
    now[0] += 9
    assert not worker.tick()  # An event requires an inventory newer than that signal.
    assert sum(name == "argo-test" for name, _ in calls) == 1
    with store.engine.connect() as conn:
        job = conn.execute(select(jobs).where(jobs.c.name == "argo-test")).mappings().one()
        source = conn.execute(select(sources).where(sources.c.name == "argo-test")).mappings().one()
    assert job["generation"] == 1
    assert job["due_at"] == inventory_at + 60
    assert source["window_count"] == 29
    assert source["next_request_at"] == 2_000_000_002
    now[0] = inventory_at + 59
    assert not worker.tick()
    now[0] += 1
    assert worker.tick()
    assert sum(name == "argo-test" for name, _ in calls) == 2
    assert worker.tick()  # The retained application request now has fresh inventory.
    assert store.service_state('sample')['instances'][0]['observations']['argo-test']['present'] is True
    with store.engine.connect() as conn:
        job = conn.execute(select(jobs).where(jobs.c.name == "argo-test")).mappings().one()
    assert job["generation"] == 1
    assert job["due_at"] == now[0] + 600
