from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import time

from sqlalchemy import (JSON, BigInteger, Boolean, Column, DateTime, Float, Index, Integer, MetaData, case, cast, delete, func,
                        String, Table, UniqueConstraint, create_engine, select, text, update)
from sqlalchemy.dialects.postgresql import insert

from .contracts import DeliveryEvent, matches_instance

metadata = MetaData()
schema = Table("schema_version", metadata, Column("version", Integer, primary_key=True))
services = Table("services", metadata,
    Column("key", String(63), primary_key=True), Column("project_id", BigInteger, unique=True, nullable=False),
    Column("project", String(512), nullable=False), Column("test_ref", String(255)), Column("team", String(128)),
    Column("active", Boolean, nullable=False, default=True), Column("registry_revision", String(64), nullable=False))
events = Table("events", metadata,
    Column("id", BigInteger, primary_key=True), Column("producer", String(128), nullable=False),
    Column("event_id", String(36), nullable=False), Column("service", String(63), nullable=False, index=True),
    Column("instance_id", String(200)), Column("kind", String(32), nullable=False),
    Column("payload", JSON, nullable=False), Column("fingerprint", String(64), nullable=False),
    Column("received_at", Float, nullable=False), Column("applied", Boolean, nullable=False),
    UniqueConstraint("producer", "event_id"))
attempt_index = Index("ix_events_attempt", events.c.service, events.c.kind,
    events.c.payload["attempt"]["project_id"].as_string(), events.c.payload["attempt"]["pipeline_id"].as_string(),
    events.c.payload["attempt"]["job_id"].as_string())
health_index = Index("ix_events_health_context", events.c.producer, events.c.service,
    events.c.payload["application_uid"].as_string(), events.c.id,
    postgresql_where=(events.c.kind == "argocd_notification") &
        (events.c.payload["event"].as_string() == "health_changed"))
streams = Table("streams", metadata,
    Column("key", String(512), primary_key=True), Column("service", String(63), nullable=False, index=True),
    Column("issuer_project", BigInteger, nullable=False), Column("ordering", JSON, nullable=False),
    Column("payload", JSON, nullable=False), Column("received_at", Float, nullable=False))
instances = Table("instances", metadata,
    Column("id", String(200), primary_key=True), Column("service", String(63), nullable=False, index=True),
    Column("environment", String(16), nullable=False), Column("name", String(63), nullable=False),
    Column("source_ref", String(255), nullable=False), Column("desired", JSON), Column("verified", JSON),
    Column("lifecycle", JSON, nullable=False), Column("observations", JSON, nullable=False),
    Column("updated_at", Float, nullable=False))
sources = Table("sources", metadata,
    Column("name", String(128), primary_key=True), Column("state", JSON, nullable=False),
    Column("last_success_at", Float), Column("last_attempt_at", Float), Column("error_code", String(80)),
    Column("failures", Integer, nullable=False, default=0), Column("next_request_at", Float, nullable=False, default=0),
    Column("window_start", Float, nullable=False, default=0), Column("window_count", Integer, nullable=False, default=0),
    Column("backoff_until", Float, nullable=False, default=0))
jobs = Table("reconcile_jobs", metadata,
    Column("name", String(128), primary_key=True), Column("due_at", Float, nullable=False),
    Column("generation", Integer, nullable=False, default=0))
application_checks = Table("application_checks", metadata,
    Column("source", String(128), primary_key=True), Column("name", String(63), primary_key=True),
    Column("snapshot", JSON(none_as_null=True)), Column("snapshot_at", Float, nullable=False, default=0),
    Column("version", BigInteger, nullable=False, default=1), Column("progress", JSON, nullable=False, default=dict),
    Column("due_at", Float, nullable=False), Column("priority", Boolean, nullable=False, default=False),
    Column("generation", BigInteger, nullable=False, default=0), Column("requested_at", Float), Column("started_at", Float),
    Column("runtime_due_at", Float),
    Column("last_step_at", Float, nullable=False, default=0), Column("last_success_at", Float),
    Column("failures", Integer, nullable=False, default=0), Column("error_code", String(80)))
Index("ix_application_checks_due", application_checks.c.source, application_checks.c.due_at)
repository_trees = Table("repository_trees", metadata,
    Column("source", String(128), primary_key=True), Column("project_id", BigInteger, primary_key=True),
    Column("revision", String(40), primary_key=True), Column("files", JSON, nullable=False, default=dict),
    Column("page", Integer, nullable=False, default=1), Column("complete", Boolean, nullable=False, default=False),
    Column("used_at", Float, nullable=False))
value_metadata = Table("value_metadata", metadata,
    Column("source", String(128), primary_key=True), Column("project_id", BigInteger, primary_key=True),
    Column("blob", String(40), primary_key=True), Column("projection", JSON, nullable=False),
    Column("used_at", Float, nullable=False))
login_flows = Table("login_flows", metadata,
    Column("state_hash", String(64), primary_key=True), Column("browser_hash", String(64), nullable=False),
    Column("verifier", String(128), nullable=False), Column("nonce", String(128), nullable=False),
    Column("return_to", String(2048), nullable=False), Column("expires_at", Float, nullable=False, index=True))
user_sessions = Table("user_sessions", metadata,
    Column("token_hash", String(64), primary_key=True), Column("user", JSON, nullable=False),
    Column("expires_at", Float, nullable=False, index=True))
ci_keys = Table("ci_keys", metadata,
    Column("issuer", String(512), primary_key=True), Column("jwks", JSON, nullable=False),
    Column("fetched_at", Float, nullable=False))


class Rejected(Exception):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status


def timestamp(value: str | None) -> float | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


def iso(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def target_id(service: str, environment: str, instance: str) -> str:
    return f"{service}:{environment}:{instance}"


def observation_matches_lifecycle(row: dict, observation: dict) -> bool:
    uid = row["lifecycle"].get("application_uid")
    return not uid or observation.get("uid") == uid


def confirmed_instance(row: dict) -> bool:
    return bool(row["desired"] or row["verified"] or row["lifecycle"].get("application_uid")
                or any(observation.get("git") for observation in row["observations"].values()))


def apply_runtime(row: dict, runtime: dict, now: float, verified: bool = False):
    life = dict(row["lifecycle"])
    uid = str(runtime["application_uid"])
    if life.get("application_uid") != uid:
        life = {"application_uid": uid, "created_at": runtime["application_created_at"],
                "age_basis": "argocd_application_creation", "first_seen_at": iso(now),
                "first_verified_at": None, "stopped_at": None, "auto_stop_at": None}
        row["verified"] = None
    if verified and life.get("first_verified_at") is None:
        life["first_verified_at"] = runtime.get("verified_at")
    if runtime.get("auto_stop_at") is not None:
        life["auto_stop_at"] = runtime["auto_stop_at"]
    row["lifecycle"] = life


class Store:
    def __init__(self, url: str):
        self.engine = create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=0,
                                    connect_args={"connect_timeout": 5, "options": "-c statement_timeout=5000"})

    def initialize(self):
        # Explicit init job/CLI, never an implicit migration on an HTTP request.
        with self.engine.begin() as conn:
            conn.execute(text("SELECT pg_advisory_xact_lock(71402401)"))
            metadata.create_all(conn)
            current = conn.execute(select(schema.c.version)).scalars().all()
            if current and current != [1]:
                raise RuntimeError("unsupported database schema")
            if not current:
                conn.execute(schema.insert().values(version=1))
            # Additive indexes also apply to existing schema-v1 databases, without changing receipts.
            attempt_index.create(conn, checkfirst=True)
            health_index.create(conn, checkfirst=True)

    def ready(self):
        with self.engine.connect() as conn:
            return conn.execute(select(schema.c.version)).scalars().all() == [1]

    def catalog(self, registrations: list[dict], revision: str, teams: dict, source="registry", now=None, source_state=None):
        now = time.time() if now is None else now
        keys, project_ids = set(), set()
        for item in registrations:
            if item["key"] in keys or item["project_id"] in project_ids:
                raise Rejected("duplicate_registry_identity")
            keys.add(item["key"]); project_ids.add(item["project_id"])
        with self.engine.begin() as conn:
            conn.execute(text("SELECT pg_advisory_xact_lock(71402402)"))
            for item in registrations:
                existing = conn.execute(select(services).where(services.c.key == item["key"]).with_for_update()).mappings().first()
                if existing and (existing["project_id"] != item["project_id"] or existing["project"] != item["project"]):
                    raise Rejected("registry_identity_changed")
                values = {**item, "team": teams.get(item["key"]), "active": True, "registry_revision": revision}
                conn.execute(insert(services).values(**values).on_conflict_do_update(index_elements=["key"], set_=values))
            conn.execute(update(services).where(services.c.key.not_in(keys)).values(active=False))
            self.ensure_source(conn, source)
            conn.execute(update(sources).where(sources.c.name == source).values(last_success_at=now, error_code=None,
                         state=source_state if source_state is not None else {"revision": revision, "count": len(keys)}))

    @staticmethod
    def instance_identity(conn, registration, environment, ref, name, authoritative=False):
        service, project = registration["key"], registration["project"]
        if not matches_instance(service, project, environment, ref, name):
            raise Rejected("instance_identity_mismatch", 422)
        if environment != "feature":
            return target_id(service, environment, name), True
        # Service locks alone cannot serialize names shared by different projects.
        conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 71402404))"), {"name": name})
        stored = conn.execute(select(instances).where(instances.c.environment == "feature",
            instances.c.name == name)).mappings().all()
        bound = False
        for row in stored:
            if confirmed_instance(row):
                if row["service"] != service or row["source_ref"] != ref:
                    raise Rejected("instance_identity_mismatch", 422)
                bound = True
            elif authoritative:
                # A failed pre-publication attempt must not reserve another branch's name.
                conn.execute(delete(streams).where(streams.c.key.startswith(row["id"] + ":")))
                conn.execute(delete(instances).where(instances.c.id == row["id"]))
        return target_id(service, environment, name), bound

    @staticmethod
    def ensure_source(conn, name):
        conn.execute(insert(sources).values(name=name, state={}).on_conflict_do_nothing())

    def update_teams(self, teams):
        with self.engine.begin() as conn:
            for row in conn.execute(select(services.c.key, services.c.team)):
                value = teams.get(row.key)
                if row.team != value:
                    conn.execute(update(services).where(services.c.key == row.key).values(team=value))

    @staticmethod
    def schedule(conn, name, due_at, minimum_due=0):
        query = insert(jobs).values(name=name, due_at=max(due_at, minimum_due), generation=1)
        conn.execute(query.on_conflict_do_update(index_elements=["name"], set_={
            "due_at": func.greatest(minimum_due, func.least(jobs.c.due_at, due_at)),
            "generation": jobs.c.generation + 1,
        }))

    @staticmethod
    def request_application(conn, source, name, now):
        """A coalesced hint, never a trusted runtime snapshot or an outbound request."""
        check = application_checks
        query = insert(check).values(source=source, name=name, due_at=now + 15, priority=True, generation=1, requested_at=now)
        conn.execute(query.on_conflict_do_update(index_elements=["source", "name"], set_={
            "due_at": func.greatest(func.coalesce(check.c.last_success_at, 0) + 60,
                                    func.least(check.c.due_at, now + 15)),
            "priority": True, "generation": check.c.generation + 1, "requested_at": now,
        }))

    def ingest(self, event: DeliveryEvent, producer_name: str, producer, integrations: dict, now=None):
        now = time.time() if now is None else now
        payload = event.model_dump(mode="json")
        canonical = dict(payload)
        # Additive v1 fields must not change identity of a retried legacy event.
        if canonical.get("build_revision") is None:canonical.pop("build_revision", None)
        if canonical.get("absence_confirmed") is False:canonical.pop("absence_confirmed", None)
        digest = sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.engine.begin() as conn:
            registration = conn.execute(select(services).where(services.c.key == event.service).with_for_update()).mappings().first()
            if not registration or not registration["active"]:
                raise Rejected("service_not_registered", 403)
            if event.source.project_id != registration["project_id"]:
                raise Rejected("source_project_mismatch", 403)
            if event.kind not in producer.kinds or event.attempt.project_id != producer.attempt_project_id:
                raise Rejected("producer_scope_denied", 403)
            if not producer.all_registered_projects and event.source.project_id not in producer.source_project_ids:
                raise Rejected("producer_project_denied", 403)
            duplicate = conn.execute(select(events).where(events.c.producer == producer_name,
                events.c.event_id == str(event.event_id))).mappings().first()
            if duplicate:
                if duplicate["fingerprint"] != digest:
                    raise Rejected("event_id_conflict")
                return {"event_id": str(event.event_id), "duplicate": True, "applied": duplicate["applied"]}
            instance_id = None
            target_confirmed = True
            confirms_target = (event.kind in {"publication", "deployment"} and event.status == "succeeded"
                               and (event.action == "upsert" or event.kind == "deployment" and event.runtime is not None))
            if event.target:
                if event.target.environment not in producer.environments:
                    raise Rejected("environment_denied", 403)
                instance_id, target_confirmed = self.instance_identity(conn, registration, event.target.environment,
                    event.source.ref, event.target.instance, authoritative=confirms_target)
            stream_key = f"{instance_id}:{event.kind}" if instance_id else f"{event.service}:build:{event.source.ref}"
            stream = (conn.execute(select(streams).where(streams.c.key == stream_key)).mappings().first()
                      if target_confirmed or confirms_target else None)
            if stream and stream["issuer_project"] != event.attempt.project_id:
                raise Rejected("stream_issuer_changed")
            order = [event.attempt.pipeline_id, event.attempt.job_id, event.attempt.sequence]
            # The service row lock serializes this check with every producer of this service.
            # Consult immutable receipts, not just the latest job retained in streams.
            attempt = select(events.c.payload).where(events.c.service == event.service,
                events.c.kind == event.kind, events.c.instance_id == instance_id,
                events.c.payload["attempt"]["project_id"].as_string() == str(event.attempt.project_id),
                events.c.payload["attempt"]["pipeline_id"].as_string() == str(event.attempt.pipeline_id),
                events.c.payload["attempt"]["job_id"].as_string() == str(event.attempt.job_id))
            if instance_id is None:
                attempt = attempt.where(events.c.payload["source"]["ref"].as_string() == event.source.ref)
            for previous in conn.execute(attempt).scalars():
                if previous["status"] != "started" and previous["status"] != event.status:
                    raise Rejected("terminal_attempt_conflict")
                if previous["attempt"]["sequence"] == event.attempt.sequence and previous != payload:
                    raise Rejected("event_order_conflict")
            applied = (target_confirmed or confirms_target) and (not stream or order > stream["ordering"])
            if stream and order[:2] == stream["ordering"][:2] and stream["payload"]["status"] != "started" and event.status != stream["payload"]["status"]:
                raise Rejected("terminal_attempt_conflict")
            if stream and order == stream["ordering"] and payload != stream["payload"]:
                # A new event ID cannot rewrite the same ordered transition.
                raise Rejected("event_order_conflict")
            if instance_id and applied:
                deleting = event.kind == "deployment" and event.action == "delete" and event.status == "succeeded"
                current_query = select(instances).where(instances.c.id == instance_id)
                current = conn.execute(current_query.with_for_update() if deleting else current_query).mappings().first()
                if current and deleting:
                    created = timestamp(current["lifecycle"].get("created_at"))
                    checked_at = min(event.occurred_at.timestamp(), event.runtime.verified_at.timestamp()) if event.runtime else event.occurred_at.timestamp()
                    # A slow runtime snapshot must not hide a newer affirmative
                    # inventory/presence check. Equal clocks favor known presence.
                    newer_presence = any(o.get("present") and any(
                        o.get(clock) and timestamp(o[clock]) >= checked_at
                        for clock in ("presence_checked_at", "inventory_observed_at", "observed_at"))
                        for o in current["observations"].values() if observation_matches_lifecycle(current, o))
                    if (created and created > checked_at) or newer_presence:
                        applied = False
                if current and event.runtime and current["lifecycle"].get("application_uid"):
                    life = current["lifecycle"]
                    if str(event.runtime.application_uid) != life["application_uid"]:
                        if event.action == "delete" or event.runtime.application_created_at.timestamp() < timestamp(life.get("created_at")):
                            applied = False
                    elif life.get("stopped_at") and event.action == "upsert" and event.status == "succeeded":
                        applied = False
                if event.kind == "publication":
                    deployment = conn.execute(select(streams).where(streams.c.key == f"{instance_id}:deployment")).mappings().first()
                    if deployment and deployment["payload"]["action"] == "delete" and deployment["payload"]["status"] == "succeeded" and order < deployment["ordering"]:
                        applied = False
            conn.execute(events.insert().values(producer=producer_name, event_id=str(event.event_id), service=event.service,
                instance_id=instance_id, kind=event.kind, payload=payload, fingerprint=digest, received_at=now, applied=applied))
            if applied:
                values = {"key": stream_key, "service": event.service, "issuer_project": event.attempt.project_id,
                          "ordering": order, "payload": payload, "received_at": now}
                conn.execute(insert(streams).values(**values).on_conflict_do_update(index_elements=["key"], set_=values))
                if instance_id:
                    row = conn.execute(select(instances).where(instances.c.id == instance_id)).mappings().first()
                    row = dict(row) if row else {"id": instance_id, "service": event.service,
                        "environment": event.target.environment, "name": event.target.instance, "source_ref": event.source.ref,
                        "desired": None, "verified": None, "lifecycle": {"first_seen_at": iso(now)}, "observations": {}}
                    if row["source_ref"] != event.source.ref and event.target.environment == "feature":
                        raise Rejected("feature_ref_changed")
                    if event.kind == "publication" and event.status == "succeeded":
                        row["desired"] = {"action": event.action, "publication": payload["publication"], "ordering": order,
                                          "reported_at": payload["occurred_at"], "event_id": str(event.event_id)}
                    if event.kind == "deployment" and event.status == "succeeded":
                        if event.action == "delete":
                            if payload["runtime"]:
                                apply_runtime(row, payload["runtime"], now)
                            row["lifecycle"] = {**row["lifecycle"], "stopped_at": payload["occurred_at"]}
                        else:
                            apply_runtime(row, payload["runtime"], now, verified=True)
                            if event.target.environment != "feature":
                                row["source_ref"] = event.source.ref
                            row["verified"] = {"publication": payload["publication"], "runtime": payload["runtime"],
                                               "ordering": order, "event_id": str(event.event_id)}
                    row["updated_at"] = now
                    # CI owns desired/lifecycle fields, never Argo observations. In particular a
                    # concurrent absence sweep must not be undone by this previously read row.
                    changed = {key: value for key, value in row.items() if key != "observations"}
                    conn.execute(insert(instances).values(**row).on_conflict_do_update(index_elements=["id"], set_=changed))
                    if event.kind == "argocd" or (event.kind in {"publication", "deployment"} and event.status != "started"):
                        for name, integration in integrations.items():
                            if integration.kind == "argocd" and event.target.environment in integration.environments:
                                self.ensure_source(conn, name)
                                last = conn.execute(select(sources.c.last_success_at).where(sources.c.name == name).with_for_update()).scalar() or 0
                                self.schedule(conn, name, now + 15, last + 60)
                                self.request_application(conn, name, event.target.instance, now)
        return {"event_id": str(event.event_id), "duplicate": False, "applied": applied}

    def list_services(self):
        with self.engine.connect() as conn:
            return [dict(row) for row in conn.execute(select(services).where(services.c.active.is_(True)).order_by(services.c.key)).mappings()]

    def catalog_state(self):
        from .runtime import summary
        with self.engine.connect() as conn:
            result = {row["key"]: {**dict(row), "instances": []} for row in conn.execute(
                select(services).where(services.c.active.is_(True)).order_by(services.c.key)).mappings()}
            for entry in conn.execute(select(instances).where(instances.c.service.in_(result)).order_by(instances.c.id)).mappings():
                row = dict(entry)
                observations = sorted(row["observations"].items(), key=lambda item: (
                    observation_matches_lifecycle(row, item[1]), item[1].get("observed_at", "")), reverse=True)
                source, latest = observations[0] if observations else (None, {})
                result[row["service"]]["instances"].append({
                    **{key: row[key] for key in ["id", "name", "environment", "source_ref", "lifecycle"]},
                    "source": source,
                    **{key: latest.get(key) for key in ["sync", "health", "observed_at", "inventory_observed_at", "chart_repo", "chart_ref", "values_ref", "check_interval_seconds"]},
                    "observation_uid": latest.get("uid"),
                    "present": latest.get("present") if observation_matches_lifecycle(row, latest) else None,
                    "source_revision": (latest.get("git") or {}).get("build_revision"),
                    **{key: (latest.get("git") or {}).get(key) for key in ("ci", "release", "version_errors")},
                    "images": (latest.get("git") or {}).get("images", []),
                    "runtime": summary(latest.get("runtime")),
                })
            return list(result.values())

    def service_state(self, key, now=None):
        now = time.time() if now is None else now
        with self.engine.connect() as conn:
            service = conn.execute(select(services).where(services.c.key == key, services.c.active.is_(True))).mappings().first()
            if not service:
                raise Rejected("service_not_found", 404)
            records = []
            for entry in conn.execute(select(instances).where(instances.c.service == key).order_by(instances.c.id)).mappings():
                row = dict(entry)
                life = row["lifecycle"]
                created, stopped, expires = timestamp(life.get("created_at")), timestamp(life.get("stopped_at")), timestamp(life.get("auto_stop_at"))
                absent = bool(row["observations"]) and all(item.get("present") is False for item in row["observations"].values())
                row["lifetime_seconds"] = max(0, int((stopped or now) - created)) if created is not None and (stopped or not absent) else None
                row["expires_in_seconds"] = int(expires - now) if expires is not None and not stopped else None
                row["stop_overdue"] = expires is not None and expires < now and not stopped
                records.append(row)
            attempts = [dict(row) for row in conn.execute(select(streams.c.key, streams.c.payload, streams.c.received_at)
                        .where(streams.c.service == key).order_by(streams.c.key)).mappings()]
            return {"service": dict(service), "instances": records, "latest_attempts": attempts, "generated_at": iso(now)}

    def event_history(self, key, before=None, limit=50, instance_id=None, source_ref=None):
        def health_at(table):
            # Match frontend eventTime: source time at millisecond precision,
            # receipt time only when the optional source timestamp is absent.
            source_time = func.date_trunc("milliseconds", cast(
                table.c.payload["health_changed_at"].as_string(), DateTime(timezone=True)))
            return func.coalesce(source_time, func.to_timestamp(table.c.received_at))

        query = select(events, health_at(events).label("health_at"))
        if key is not None:
            query = query.where(events.c.service == key)
        else:
            query = query.join(services, events.c.service == services.c.key).where(services.c.active.is_(True))
        if instance_id is not None:
            query = query.where((events.c.instance_id == instance_id) | (
                (events.c.kind == "build") & (events.c.payload["source"]["ref"].as_string() == source_ref)))
        if before is not None:
            query = query.where(events.c.id < before)
        page = query.order_by(events.c.id.desc()).limit(limit).cte("history_page").prefix_with("MATERIALIZED")
        page_uid = page.c.payload["application_uid"].as_string()
        scopes = select(page.c.producer, page.c.service, page_uid.label("uid"),
                        func.max(page.c.health_at).label("latest")).where(
            page.c.kind == "argocd_notification", page.c.payload["event"].as_string() == "health_changed",
            page_uid.is_not(None)).group_by(page.c.producer, page.c.service, page_uid).cte("history_scopes")

        # Rank the requested UIDs' health timelines as one batch. Receipt pagination is
        # deliberately absent here: a late receipt can precede this page in source time.
        uid, health, occurred = events.c.payload["application_uid"].as_string(), events.c.payload["health"].as_string(), health_at(events)
        partition = [events.c.producer, events.c.service, uid]
        ranked = select(events.c.id, events.c.producer, events.c.service, uid.label("uid"),
                        health.label("health"), occurred.label("health_at"),
                        func.row_number().over(partition_by=partition, order_by=[occurred, events.c.id]).label("position")
        ).select_from(events.join(scopes, (events.c.producer == scopes.c.producer) &
            (events.c.service == scopes.c.service) & (uid == scopes.c.uid))).where(
            events.c.kind == "argocd_notification", events.c.payload["event"].as_string() == "health_changed",
            occurred <= scopes.c.latest).cte("history_ranked").prefix_with("MATERIALIZED")
        # Progressing/Suspended preserve the last decisive state. Position, unlike
        # receipt ID, increases in source-time order even for reordered deliveries.
        context = select(ranked.c.id, ranked.c.uid,
            func.max(case((ranked.c.health.in_(["Healthy", "Degraded", "Missing", "Unknown"]),
                           ranked.c.position), else_=None)).over(
                partition_by=[ranked.c.producer, ranked.c.service, ranked.c.uid],
                order_by=[ranked.c.health_at, ranked.c.id], rows=(None, -1)).label("previous_position")
        ).cte("history_context")
        # Keep the previous-state join bounded by the page, preventing PostgreSQL
        # from joining two complete timelines when its cardinality estimate is low.
        wanted = select(*(page.c[column.name] for column in events.c), context.c.uid, context.c.previous_position
        ).select_from(page.outerjoin(context, context.c.id == page.c.id)).cte("history_wanted").prefix_with("MATERIALIZED")
        previous = ranked.alias("previous_health")
        result = select(*(wanted.c[column.name] for column in events.c), previous.c.health.label("previous_health")
        ).select_from(wanted.outerjoin(previous, (previous.c.producer == wanted.c.producer) &
            (previous.c.service == wanted.c.service) & (previous.c.uid == wanted.c.uid) &
            (previous.c.position == wanted.c.previous_position))).order_by(wanted.c.id.desc())
        with self.engine.connect() as conn:
            rows = [dict(row) for row in conn.execute(result).mappings()]
            for row in rows:
                if row["kind"] != "argocd_notification" or row["payload"].get("event") != "health_changed":
                    row.pop("previous_health")
            return rows

    def source_status(self):
        with self.engine.connect() as conn:
            return [dict(row) for row in conn.execute(select(sources)).mappings()]

    def environment_inventory(self, registry_sources):
        with self.engine.connect() as conn:
            snapshots = [value for value in conn.execute(select(sources.c.state["published_environments"])
                         .where(sources.c.name.in_(registry_sources))).scalars() if value is not None]
        return {name for snapshot in snapshots for name in snapshot} if snapshots else None
