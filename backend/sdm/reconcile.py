"""Read-only, budgeted GitLab/Argo reconciliation. One worker lease per DB."""
import ast
import base64
from datetime import datetime, timezone
import hashlib
import json
import logging
import random
import re
import time
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlsplit

import httpx
import yaml
from pydantic import ValidationError
from joserfc.jwk import KeySet
from sqlalchemy import case, func, select, text, update
from sqlalchemy.dialects.postgresql import insert

from .config import secret
from .contracts import ENVIRONMENTS, Image, Runtime
from .store import (Rejected, Store, apply_runtime, confirmed_instance, instances, iso, jobs, observation_matches_lifecycle, services, timestamp,
                    sources)
from .store import ci_keys
from .resource_projection import workload_metadata
from .runtime import collect_runtime
from .reconcile_errors import Deferred, SourceFailure, Superseded
from . import application_queue, repository_cache, delivery_versions

log = logging.getLogger("sdm.reconcile")


def superseded_application(row, app):
    life = row["lifecycle"]
    created = timestamp(app["created_at"])
    if life.get("stopped_at") and (life.get("application_uid") == app["uid"] or
                                  created <= timestamp(life["stopped_at"])):
        return True
    return bool(life.get("application_uid") and life["application_uid"] != app["uid"] and
                life.get("created_at") and created <= timestamp(life["created_at"]))


def registry_from_python(content: str) -> list[dict]:
    tree = ast.parse(content)
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "SERVICES" for t in node.targets)]
    if len(assignments) != 1:
        raise ValueError("one literal SERVICES assignment is required")
    registry = ast.literal_eval(assignments[0].value)
    if not isinstance(registry, dict):
        raise ValueError("SERVICES must be a mapping")
    result = []
    import re
    for key, entry in registry.items():
        if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", key):
            raise ValueError("invalid service key")
        if not isinstance(entry, dict) or type(entry.get("project_id")) is not int or entry["project_id"] <= 0:
            raise ValueError("invalid project id")
        project = entry.get("project")
        if not isinstance(project, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+", project):
            raise ValueError("invalid project path")
        ref = entry.get("test_ref")
        if ref is not None and (not isinstance(ref, str) or not ref or len(ref) > 255):
            raise ValueError("invalid test ref")
        result.append({"key": key, "project_id": entry["project_id"], "project": project, "test_ref": ref})
    return result


def published_environments(body: bytes) -> list[str]:
    entries = json.loads(body)
    # Root contains at most one directory per supported delivery target.
    # Do not silently accept a possibly truncated repository-tree response.
    if not isinstance(entries, list) or len(entries) >= 100:
        raise ValueError("invalid environment inventory")
    found = {item.get("name") for item in entries if isinstance(item, dict) and item.get("type") == "tree"
             and item.get("name") in ENVIRONMENTS and item.get("path") == f"kubernetes/{item.get('name')}"}
    return [name for name in ENVIRONMENTS if name != "feature" and name in found]


def app_snapshot(app: dict, integration, require_revision=True) -> dict | None:
    """Persist only an explicit metadata projection, never inline Helm values."""
    meta, spec, status = app.get("metadata", {}), app.get("spec", {}), app.get("status", {})
    if spec.get("project") not in integration.projects:
        return None
    app_sources = spec.get("sources") or [spec.get("source", {})]
    repo = integration.deployment_repo_url.removesuffix(".git").rstrip("/")
    values_index = next((i for i, item in enumerate(app_sources)
        if item.get("repoURL", "").removesuffix(".git").rstrip("/") == repo and item.get("ref") == "values"), None)
    if values_index is None:
        return None
    files = [path for item in app_sources for path in (item.get("helm") or {}).get("valueFiles", [])
             if path.startswith("$values/kubernetes/") and path.endswith("/values.yaml")]
    if len(files) != 1:
        return None
    path = files[0].removeprefix("$values/")
    parts = path.split("/")
    if len(parts) != 4 or parts[1] not in integration.environments or parts[2] != meta.get("name"):
        return None
    revisions = (status.get("sync") or {}).get("revisions") or []
    revision = revisions[values_index] if values_index < len(revisions) else None
    if not isinstance(revision, str) or len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        if require_revision:
            return None  # Never read moving HEAD in place of a resolved source.
        revision = None
    if not meta.get("uid") or not meta.get("creationTimestamp"):
        return None
    runtime = Runtime.model_validate({
        "application": meta["name"], "application_uid": meta["uid"],
        "application_created_at": meta["creationTimestamp"],
        "namespace": (spec.get("destination") or {}).get("namespace"),
    }).model_dump(mode="json")
    chart = next((item for item in app_sources if item.get("helm")), {})
    chart_url = urlsplit(chart.get("repoURL", ""))
    if chart_url.username or chart_url.password or chart_url.query or chart_url.fragment:
        raise ValueError("chart repository must not contain credentials or query parameters")
    return {"name": runtime["application"], "uid": runtime["application_uid"], "created_at": runtime["application_created_at"],
        "namespace": runtime["namespace"], "project": spec["project"],
        "environment": parts[1], "values_path": path, "values_revision": revision,
        "values_ref": app_sources[values_index].get("targetRevision"),
        "chart_repo": chart.get("repoURL"), "chart_ref": chart.get("targetRevision"),
        "release_name": (chart.get("helm") or {}).get("releaseName") or runtime["application"],
        "sync": (status.get("sync") or {}).get("status", "Unknown"),
        "health": (status.get("health") or {}).get("status", "Unknown"),
        "check_interval_seconds": integration.interval_seconds,
        "resources": [{**{key: item.get(key) for key in ("group", "kind", "namespace", "name", "status")},
                       "health": (item.get("health") or {}).get("status")}
                      for item in status.get("resources", [])[:1000]]}


def values_projection(content: bytes) -> dict:
    values = yaml.safe_load(content)
    if not isinstance(values, dict):
        raise ValueError("invalid generated values")
    workloads = list((values.get("deployments") or {}).values()) + list((values.get("jobs") or {}).values())
    if not workloads:
        raise ValueError("no workload metadata")
    annotations = workloads[0].get("annotations") or {}
    prefix = "delivery.example.com/"
    project, ref, revision = (annotations.get(prefix + key) for key in ("source-project", "source-ref", "source-revision"))
    if not project or not ref or not revision:
        raise ValueError("source identity is missing")
    images = []
    for workload in workloads:
        image = workload.get("image")
        if image:
            parsed = Image.model_validate(image).model_dump()
            if parsed not in images:
                images.append(parsed)
    managed = json.loads(annotations.get(prefix + "config-managed-files", "[]"))
    if not isinstance(managed, list) or not all(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) for name in managed):
        raise ValueError("invalid managed config filenames")
    return {"projection_version": repository_cache.PROJECTION_VERSION, "project": project, "source_ref": ref, "source_revision": revision,
            "build_revision": annotations.get(prefix + "build-source-revision"),
            "publisher_pipeline": annotations.get(prefix + "publisher-pipeline"), "images": images,
            "config_revision": annotations.get(prefix + "config-revision"), "namespace": values.get("namespace"),
            "build_job": annotations.get(prefix + "build-job"), "build_pipeline": annotations.get(prefix + "build-pipeline"),
            "release_operation": annotations.get(prefix + "release-operation"),
            "config_project": annotations.get(prefix + "config-project"),
            "config_managed_files": managed,
            "config_dir": annotations.get(prefix + "config-dir"), "config_ref": annotations.get(prefix + "config-ref"),
            "workloads": workload_metadata(values)}


class Reconciler:
    rejected_error = Rejected
    application_errors = (SourceFailure, ValueError, KeyError, TypeError, SyntaxError, RecursionError, OverflowError, Rejected, yaml.YAMLError)

    @staticmethod
    def origin_failure(code):
        return code in {"connection_failed", "http_401", "http_408", "http_429"} or bool(re.fullmatch(r"http_5\d\d", code))

    def __init__(self, store: Store, settings, client=None, clock=time.time, jitter=random.uniform):
        self.store, self.settings, self.clock, self.jitter = store, settings, clock, jitter
        self.client = client or httpx.Client(follow_redirects=False)

    def bootstrap(self):
        with self.store.engine.begin() as conn:
            for name in self.settings.integrations:
                self.store.ensure_source(conn, name)
                conn.execute(insert(jobs).values(name=name, due_at=self.clock() + self.jitter(0, 30), generation=0)
                             .on_conflict_do_nothing())
            if self.settings.ci_identity:
                identity = self.settings.ci_identity
                if not conn.execute(select(ci_keys.c.issuer).where(ci_keys.c.issuer == identity.issuer)).first():
                    self.store.schedule(conn, identity.gitlab_source, self.clock())

    def get(self, name, path, params=None, etag=None):
        config = self.settings.integrations[name]
        now = self.clock()
        # Persistent budget shared by all worker replicas and event-triggered refreshes.
        with self.store.engine.begin() as conn:
            self.store.ensure_source(conn, name)
            state = conn.execute(select(sources).where(sources.c.name == name).with_for_update()).mappings().one()
            until = max(state["next_request_at"], state["backoff_until"])
            window_start, count = state["window_start"], state["window_count"]
            if now >= window_start + config.window_seconds:
                window_start, count = now, 0
            if count >= config.requests_per_window:
                until = max(until, window_start + config.window_seconds)
            if now < until:
                raise Deferred(until, name)
            conn.execute(update(sources).where(sources.c.name == name).values(window_start=window_start,
                window_count=count + 1, next_request_at=now + config.min_request_interval_seconds, last_attempt_at=now))
        token = secret(config.token_env)
        headers = {"PRIVATE-TOKEN": token} if config.kind == "gitlab" else {"Authorization": f"Bearer {token}"}
        if etag:
            headers["If-None-Match"] = etag
        try:
            with self.client.stream("GET", config.base_url + path, params=params, headers=headers,
                                    timeout=config.timeout_seconds) as response:
                if response.status_code == 304:
                    return None, etag
                if response.status_code != 200:
                    retry = response.headers.get("Retry-After", "0")
                    try:
                        delay = float(retry) if retry.isdigit() else parsedate_to_datetime(retry).timestamp() - now
                    except (ValueError, TypeError):
                        delay = 0
                    delay = max(0, min(3600, delay))
                    raise SourceFailure(f"http_{response.status_code}", delay, name)
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    limit = 32 * 1024 * 1024 if config.kind == "argocd" and path == "/api/v1/applications" else 2 * 1024 * 1024
                    if len(body) > limit:
                        raise SourceFailure("response_too_large", source=name)
                with self.store.engine.begin() as conn:
                    conn.execute(update(sources).where(sources.c.name == name,
                        sources.c.error_code.in_(["connection_failed", "http_401", "http_408", "http_429"]) |
                        sources.c.error_code.like("http_5%")).values(error_code=None, failures=0, backoff_until=0))
                return bytes(body), response.headers.get("etag")
        except (httpx.HTTPError, SourceFailure) as error:
            failure = error if isinstance(error, SourceFailure) else SourceFailure("connection_failed", source=name)
            if self.origin_failure(failure.code):
                with self.store.engine.begin() as conn:
                    conn.execute(update(sources).where(sources.c.name == name).values(error_code=failure.code,
                        backoff_until=self.clock() + max(30, failure.retry_after)))
            raise failure from None

    def source_state(self, name):
        with self.store.engine.connect() as conn:
            return dict(conn.execute(select(sources).where(sources.c.name == name)).mappings().one())

    def save_state(self, name, state):
        with self.store.engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.name == name).values(state=state))

    def fail_source(self, name, error):
        previous = self.source_state(name)
        failures = previous["failures"] + 1
        code = error.code if isinstance(error, (SourceFailure, Rejected)) else "invalid_source_data"
        delay = max(min(3600, 30 * 2 ** min(failures - 1, 7)), getattr(error, "retry_after", 0))
        due = self.clock() + delay + self.jitter(0, 10)
        with self.store.engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.name == name).values(error_code=code, failures=failures,
                backoff_until=due, state={k: v for k, v in previous["state"].items() if k != "_registry_pending"}))
        log.warning("reconcile failed source=%s code=%s", name, code)
        return due

    def mark_application_error(self, name, app, code):
        self.record_application_error(name, app["name"], code)
        with self.store.engine.begin() as conn:
            for row in conn.execute(select(instances).where(instances.c.name == app["name"],
                                   instances.c.environment == app["environment"]).with_for_update()).mappings():
                old = row["observations"].get(name)
                if old and old.get("uid") == app["uid"] and not row["lifecycle"].get("stopped_at") and observation_matches_lifecycle(row, old):
                    conn.execute(update(instances).where(instances.c.id == row["id"]).values(observations={
                        **row["observations"], name: {**old, "collection_error": {"code": code, "checked_at": iso(self.clock())}}}))

    def record_application_error(self, source, application, code):
        log.warning("application check failed source=%s application=%s code=%s", source, application, code)
        with self.store.engine.begin() as conn:
            state = dict(conn.execute(select(sources.c.state).where(sources.c.name == source).with_for_update()).scalar() or {})
            state["last_application_error"] = {"application": application, "code": code, "checked_at": self.clock()}
            conn.execute(update(sources).where(sources.c.name == source).values(state=state))

    def eligible_sources(self):
        with self.store.engine.connect() as conn:
            rows = {r["name"]: r for r in conn.execute(select(sources)).mappings()}
        eligible = []
        for name, config in self.settings.integrations.items():
            row = rows.get(name) or {}
            until = max(row.get("next_request_at", 0), row.get("backoff_until", 0))
            end = row.get("window_start", 0) + config.window_seconds
            if end > self.clock() and row.get("window_count", 0) >= config.requests_per_window:
                until = max(until, end)
            if self.clock() >= until:
                eligible.append(name)
        return eligible

    def registry(self, name):
        config = self.settings.integrations[name]
        identity = self.settings.ci_identity
        if identity and identity.gitlab_source == name:
            with self.store.engine.connect() as conn:
                cached = conn.execute(select(ci_keys).where(ci_keys.c.issuer == identity.issuer)).mappings().first()
            if not cached or self.clock() - cached["fetched_at"] >= config.interval_seconds:
                body, _ = self.get(name, "/oauth/discovery/keys")
                keys = [{k: row[k] for k in ["kty", "kid", "use", "n", "e", "alg"] if k in row}
                        for row in json.loads(body).get("keys", [])
                        if row.get("kty") == "RSA" and row.get("use", "sig") == "sig" and row.get("alg", "RS256") == "RS256"]
                if not keys or len(keys) > 16:
                    raise ValueError("invalid CI signing keys")
                try:
                    KeySet.import_key_set({"keys": keys})
                except Exception:
                    raise ValueError("invalid CI signing keys") from None
                value = {"issuer": identity.issuer, "jwks": {"keys": keys}, "fetched_at": self.clock()}
                with self.store.engine.begin() as conn:
                    conn.execute(insert(ci_keys).values(**value).on_conflict_do_update(index_elements=["issuer"], set_=value))
        previous = self.source_state(name)["state"]
        pending = previous.get("_registry_pending")
        identity_key = [config.project_id, config.ref, config.registry_path]
        if pending and pending.get("identity") != identity_key:
            pending = None
        if pending is None:
            body, etag = self.get(name, f"/api/v4/projects/{config.project_id}/repository/files/{quote(config.registry_path, safe='')}",
                                  params={"ref": config.ref}, etag=previous.get("etag") if previous.get("registry_identity") == identity_key else None)
            pending = {"etag": etag, "identity": identity_key,
                       "generation": getattr(self, "_active_generation", 0)}
            if body is not None:
                file = json.loads(body)
                raw = base64.b64decode(file["content"], validate=True).decode()
                pending.update(registrations=registry_from_python(raw), revision=file["last_commit_id"])
            previous = {**previous, "_registry_pending": pending}
            self.save_state(name, previous)
        try:
            body, _ = self.get(name, f"/api/v4/projects/{config.project_id}/repository/tree",
                               params={"path": "kubernetes", "ref": config.ref, "per_page": 100})
            environments = published_environments(body)
        except SourceFailure as error:
            if error.code != "http_404":
                raise
            environments = []  # No generated state before the first publication.
        state = {**{key: value for key, value in previous.items() if key != "_registry_pending"},
                 "etag": pending["etag"], "registry_identity": identity_key, "published_environments": environments}
        if "registrations" in pending:
            registrations = pending["registrations"]
            state.update(revision=pending["revision"], count=len(registrations))
            self.store.catalog(registrations, pending["revision"], self.settings.teams, source=name,
                               now=self.clock(), source_state=state)
        else:
            self.save_state(name, state)
            self.store.update_teams(self.settings.teams)
        return pending["generation"]

    def argo(self, name):
        config = self.settings.integrations[name]
        application_queue.migrate_legacy(self, name)
        observed_at = self.clock()
        # Some Argo versions silently remove required identity fields even for
        # seemingly valid fields masks. Project locally before persisting instead.
        body, _ = self.get(name, "/api/v1/applications", params=[('projects', p) for p in config.projects])
        response = json.loads(body)
        if not isinstance(response.get("items"), list) or len(response["items"]) > 5000:
            raise SourceFailure("invalid_application_list")
        snapshots, listed, errors, uncertain = [], [], {}, set()
        for raw in response["items"]:
            if not isinstance(raw, dict):
                raise SourceFailure("invalid_application_list")
            meta, spec = raw.get("metadata", {}), raw.get("spec", {})
            if (not isinstance(meta, dict) or not isinstance(spec, dict)
                    or not isinstance(spec.get("project"), str) or not spec["project"]):
                raise SourceFailure("incomplete_application_list")
            if spec.get("project") not in config.projects:
                continue
            if not all(isinstance(meta.get(key), str) and meta[key] for key in ("name", "uid", "creationTimestamp")):
                raise SourceFailure("incomplete_application_list")
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", meta["name"]):
                raise SourceFailure("incomplete_application_list")
            try:
                destination = spec.get("destination")
                identity = Runtime.model_validate({"application": meta["name"], "application_uid": meta["uid"],
                    "application_created_at": meta["creationTimestamp"],
                    "namespace": destination.get("namespace") if isinstance(destination, dict) else None}).model_dump(mode="json")
            except (ValueError, TypeError):
                uncertain.add(meta["name"])
                errors[meta["name"]] = "invalid_application_data"
                continue
            listed.append({"name": identity["application"], "uid": identity["application_uid"], "project": spec["project"]})
            try:
                snapshot = app_snapshot(raw, config, require_revision=False)
                if snapshot and snapshot.get("values_revision"):
                    snapshots.append(snapshot)
                elif snapshot:
                    errors[snapshot["name"]] = "unresolved_values_revision"
                else:
                    errors[str(meta.get("name", "unknown"))[:63]] = "invalid_application_data"
            except (ValueError, KeyError, TypeError, Rejected):
                errors[str(meta.get("name", "unknown"))[:63]] = "invalid_application_data"
        application_queue.enqueue_inventory(self, name, snapshots, listed, errors, observed_at, uncertain)
        state = self.source_state(name)["state"]
        self.save_state(name, {"count": len(snapshots), "ignored": len(listed) + len(uncertain) - len(snapshots),
            "application_errors": errors, "runtime_turn": state.get("runtime_turn", 0),
            **({"last_application_error": state["last_application_error"]} if state.get("last_application_error") else {})})
        if errors:
            failed = sorted(errors)[0]
            self.record_application_error(name, failed, errors[failed])
        return getattr(self, "_active_generation", 0)

    def collect_application(self, name, app, state, checkpoint=None):
        config = self.settings.integrations[name]
        checkpoint = checkpoint or (lambda: self.save_state(name, state))
        with self.store.engine.connect() as conn:
            known = conn.execute(select(instances).where(instances.c.environment == app["environment"],
                instances.c.name == app["name"])).mappings().first()
        recorded = (known["observations"].get(name) if known else None) or {}
        if known and confirmed_instance(known) and superseded_application(known, app):
            state["ignored"] += 1
            return
        projection = app.get("_git") if app.get("_git_revision") == app["values_revision"] else None
        if projection and projection.get("projection_version") != repository_cache.PROJECTION_VERSION:
            projection = None
        if projection is None:
            projection = repository_cache.values_projection(self, config, app, recorded, values_projection)
            app["_git"] = projection
            app["_git_revision"] = app["values_revision"]
            checkpoint()
        runtime = None
        if config.runtime_enabled:
            with self.store.engine.begin() as conn:
                registered = conn.execute(select(services).where(services.c.project == projection["project"],
                    services.c.active.is_(True)).with_for_update()).mappings().first()
                if registered:
                    self.application_identity(conn, registered, app, projection)
            if registered:
                cached = recorded.get("runtime") or {}
                if state.get("_allow_cached_runtime") and cached and app.get("_values_blob") == recorded.get("values_blob"):
                    runtime = cached
                    state["_metadata_only"] = True
                else:
                    runtime = collect_runtime(name, app, cached, self.get, checkpoint, self.clock, config.runtime_max_resources)
        with self.store.engine.connect() as conn:
            version_service = conn.execute(select(services).where(services.c.project == projection["project"],
                services.c.active.is_(True))).mappings().first()
        projection = delivery_versions.enrich(self, config, app, projection, version_service)
        with self.store.engine.begin() as conn:
            if state.get("_check"):
                check = state["_check"]
                current_version = conn.execute(select(application_queue.checks.c.version).where(
                    application_queue.checks.c.source == name, application_queue.checks.c.name == app["name"])).scalar()
                if current_version != check["version"]:
                    raise Superseded()
            service = conn.execute(select(services).where(services.c.project == projection["project"],
                services.c.active.is_(True)).with_for_update()).mappings().first()
            if service is None:
                state["ignored"] += 1
            else:
                key = self.application_identity(conn, service, app, projection, authoritative=True)
                stored = conn.execute(select(instances).where(instances.c.id == key).with_for_update()).mappings().first()
                # CI can stop or replace this incarnation while runtime HTTP requests are in flight.
                if stored and superseded_application(stored, app):
                    state["ignored"] += 1
                    return
                row = dict(stored) if stored else {"id": key, "service": service["key"], "name": app["name"],
                    "environment": app["environment"], "source_ref": projection["source_ref"], "desired": None,
                    "verified": None, "lifecycle": {}, "observations": {}}
                # An observation started before a newer CI event must not rewind its lifecycle.
                if (not stored or row["lifecycle"].get("application_uid") != app["uid"] or
                        row["updated_at"] <= datetime.fromisoformat(state["observed_at"]).timestamp()):
                    apply_runtime(row, {"application_uid": app["uid"], "application_created_at": app["created_at"]}, self.clock())
                    if app["environment"] != "feature":
                        row["source_ref"] = projection["source_ref"]
                public_app = {k: v for k, v in app.items() if not k.startswith("_")}
                public_app["check_interval_seconds"] = state.get("_check_interval", config.interval_seconds)
                observed_at = runtime["observed_at"] if runtime else state["observed_at"]
                row["observations"] = {**row["observations"], name: {**public_app, "git": projection, "values_blob": app.get("_values_blob"),
                                       **({"runtime": runtime} if runtime is not None else {}),
                                       "observed_at": observed_at, "inventory_observed_at": state["observed_at"],
                                       "presence_checked_at": state["observed_at"], "present": True}}
                row["updated_at"] = max(row.get("updated_at", 0), self.clock())
                conn.execute(insert(instances).values(**row).on_conflict_do_update(index_elements=["id"], set_=row))
                state["seen"].append(key)

    def application_identity(self, conn, service, app, projection, authoritative=False):
        if projection["namespace"] != app["namespace"]:
            raise SourceFailure("application_identity_mismatch")
        try:
            key, _ = self.store.instance_identity(conn, service, app["environment"], projection["source_ref"],
                                                  app["name"], authoritative=authoritative)
            return key
        except Rejected:
            raise SourceFailure("application_identity_mismatch") from None

    def tick(self):
        # Holding a connection-scoped PostgreSQL lock limits workers to one HTTP request at a time.
        with self.store.engine.connect() as leader:
            locked = leader.execute(text("SELECT pg_try_advisory_lock(71402403)")).scalar()
            leader.commit()
            if not locked:
                return False
            try:
                eligible = self.eligible_sources()
                with self.store.engine.connect() as conn:
                    job = conn.execute(select(jobs).where(jobs.c.due_at <= self.clock(),
                        jobs.c.name.in_(eligible)).order_by(jobs.c.due_at).limit(1)).mappings().first()
                if not job or job["name"] not in self.settings.integrations:
                    check = application_queue.choose(self, eligible)
                    return application_queue.run(self, check) if check else False
                name, config, now = job["name"], self.settings.integrations[job["name"]], self.clock()
                completed = False
                self._active_generation = job["generation"]
                try:
                    collected = self.registry(name) if config.kind == "gitlab" else self.argo(name)
                    completed_generation = collected if type(collected) is int else job["generation"]
                    finished = self.clock()
                    due = (now if config.kind == "argocd" else finished) + config.interval_seconds + self.jitter(0, config.interval_seconds * .1)
                    due = max(due, finished + 60)
                    partial = self.source_state(name)["state"].get("application_errors")
                    with self.store.engine.begin() as conn:
                        conn.execute(update(sources).where(sources.c.name == name).values(last_success_at=finished,
                            error_code="partial_application_failure" if partial else None, failures=0, backoff_until=0))
                        # Events arriving during collection keep their generation, but cannot immediately
                        # repeat a successful cycle. Senders lock the source before scheduling this row.
                        conn.execute(update(jobs).where(jobs.c.name == name).values(due_at=case(
                            (jobs.c.generation == completed_generation, due),
                            else_=func.greatest(jobs.c.due_at, finished + 60))))
                    completed = True
                    if config.kind == "gitlab":
                        repository_cache.prune(self.store, finished)
                except Deferred as error:
                    due = max(now + 1, error.until)
                except (SourceFailure, ValueError, KeyError, TypeError, SyntaxError, RecursionError, OverflowError, Rejected, yaml.YAMLError) as error:
                    due = self.fail_source(name, error)
                if not completed:
                    with self.store.engine.begin() as conn:
                        # A concurrent event may request another refresh; do not drop that request.
                        conn.execute(update(jobs).where(jobs.c.name == name, jobs.c.generation == job["generation"]).values(due_at=due))
                return True
            finally:
                leader.execute(text("SELECT pg_advisory_unlock(71402403)"))
                leader.commit()
