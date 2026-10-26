import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from sdm.api import create_app
from sdm.config import Producer, Settings
from sdm.contracts import DeliveryEvent, feature_id
from sdm.store import Store, metadata


@pytest.fixture
def store():
    url = os.environ["SDM_TEST_DATABASE_URL"]
    assert make_url(url).database == "sdm_test", "tests require their dedicated disposable database"
    result = Store(url)
    metadata.drop_all(result.engine)
    result.initialize()
    result.catalog([{"key": "sample", "project_id": 100, "project": "example/sample", "test_ref": "dev"}], "fixture", {})
    yield result
    result.engine.dispose()


@pytest.fixture
def settings(store, monkeypatch):
    for name in ["TEST_READER", "TEST_PUBLISHER", "TEST_BUILD", "TEST_GITLAB", "TEST_ARGO"]:
        monkeypatch.setenv(name, name.lower() * 8)
    return Settings(database_url=str(store.engine.url), reader_token_env="TEST_READER", reconcile_enabled=False,
        frontend_dir=None, producers={
            "publisher": Producer(token_env="TEST_PUBLISHER", kinds=["publication", "deployment", "argocd"],
                all_registered_projects=True, attempt_project_id=900, environments=["test", "feature", "prod", "preprod"]),
            "build": Producer(token_env="TEST_BUILD", kinds=["build"], source_project_ids=[100], attempt_project_id=100),
        })


@pytest.fixture
def client(store, settings):
    with TestClient(create_app(settings, store)) as result:
        yield result


@pytest.fixture
def headers(settings):
    return {"X-Producer-ID": "publisher", "Authorization": "Bearer " + os.environ["TEST_PUBLISHER"]}


@pytest.fixture
def event():
    def make(kind="publication", status="succeeded", pipeline=10, sequence=1, feature=False, action="upsert", uid=None):
        ref = "feature/topic" if feature else "dev"
        name = feature_id("sample", "example/sample", ref) if feature else "sample"
        env = "feature" if feature else "test"
        result = {"schema_version": 1, "event_id": str(uuid4()), "service": "sample", "kind": kind,
            "status": status, "action": action, "source": {"project_id": 100, "ref": ref, "revision": "a" * 40},
            "attempt": {"project_id": 100 if kind == "build" else 900, "pipeline_id": pipeline,
                        "job_id": pipeline * 10, "sequence": sequence},
            "occurred_at": "2026-01-02T00:00:00Z"}
        images = [{"repository": "registry.example/sample", "digest": "sha256:" + "b" * 64}]
        if kind == "build":
            result["images"] = images if status == "succeeded" else []
        else:
            result["target"] = {"environment": env, "instance": name}
        if kind in {"publication", "deployment"} and status == "succeeded" and action == "upsert":
            result["publication"] = {"revision": "c" * 40, "values_revision": "a" * 40, "build_revision": "d" * 40,
                "values_path": f"kubernetes/{env}/{name}/values.yaml", "images": images, "chart_ref": "v1.0.0"}
        if kind == "deployment" and status == "succeeded":
            result["runtime"] = {"application": name, "application_uid": uid or "11111111-1111-4111-8111-111111111111",
                "application_created_at": "2026-01-01T00:00:00Z", "namespace": "sample",
                "verified_at": "2026-01-02T00:00:00Z"}
        if status in {"failed", "canceled"}:
            result["failure_code"] = "verification_failed"
        return result
    return make


@pytest.fixture
def drain_checks():
    """Run the independent queue with a virtual clock; no discovery or wall-clock sleeps."""
    from sqlalchemy import select
    from sdm.application_queue import choose, run
    from sdm.store import application_checks, sources

    def drain(worker):
        original = worker.clock
        now = [original()]
        worker.clock = lambda: now[0]
        try:
            for _ in range(1000):
                with worker.store.engine.connect() as conn:
                    pending = [dict(r) for r in conn.execute(select(application_checks).where(
                        application_checks.c.snapshot.is_not(None), application_checks.c.error_code.is_(None),
                        (application_checks.c.last_success_at.is_(None) | application_checks.c.started_at.is_not(None) |
                         (application_checks.c.due_at <= now[0])))).mappings()]
                if not pending:
                    return
                if any(worker.origin_failure(s["error_code"] or "") for s in worker.store.source_status()):
                    return
                row = choose(worker, worker.eligible_sources())
                if row:
                    run(worker, row)
                    continue
                with worker.store.engine.connect() as conn:
                    states = {r["name"]: r for r in conn.execute(select(sources)).mappings()}
                gates = []
                for row in pending:
                    state = states[row["source"]]
                    config = worker.settings.integrations[row["source"]]
                    end = state["window_start"] + config.window_seconds
                    until = max(state["next_request_at"], state["backoff_until"], end if state["window_count"] >= config.requests_per_window and end > now[0] else 0)
                    gates.append(max(row["due_at"], until))
                now[0] = max(now[0] + .01, min(gates))
            pytest.fail("application queue did not settle")
        finally:
            worker.clock = original
    return drain
