"""Metadata-only Argo signals. A notification never confirms runtime state."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import time
from typing import Literal
from uuid import UUID, NAMESPACE_URL, uuid5

from pydantic import Field, field_validator, model_validator
from sqlalchemy import select

from .contracts import Model, Name
from .store import Rejected, events, services, sources


class ArgoNotification(Model):
    schema_version: Literal[1]
    source: Name
    event: Literal["created", "deleting", "sync_running", "sync_succeeded", "sync_failed", "health_changed"]
    project: Name
    application: Name
    application_uid: UUID
    application_created_at: datetime
    resource_version: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    namespace: Name
    environment: Literal["test", "feature", "preprod", "prod"]
    source_project: str = Field(max_length=512, pattern=r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$")
    source_ref: str = Field(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f]+$")
    values_path: str = Field(max_length=512, pattern=r"^kubernetes/(test|feature|preprod|prod)/[a-z0-9-]+/values\.yaml$")
    sync: Literal["Unknown", "Synced", "OutOfSync"] = "Unknown"
    health: Literal["Unknown", "Healthy", "Progressing", "Degraded", "Suspended", "Missing"] = "Unknown"
    revisions: list[str] = Field(default_factory=list, max_length=8)
    operation_started_at: datetime | None = None
    operation_finished_at: datetime | None = None
    deletion_started_at: datetime | None = None
    health_changed_at: datetime | None = None

    @field_validator("revisions")
    @classmethod
    def revision_metadata(cls, value):
        import re
        if any(not re.fullmatch(r"[A-Za-z0-9._/-]{1,128}", revision) for revision in value):
            raise ValueError("invalid revision metadata")
        return value

    @field_validator("application_created_at", "operation_started_at", "operation_finished_at", "deletion_started_at", "health_changed_at")
    @classmethod
    def aware(cls, value):
        if value is not None and value.utcoffset() is None:
            raise ValueError("timezone is required")
        return value.astimezone(timezone.utc) if value else None

    @model_validator(mode="after")
    def identity(self):
        if self.values_path != f"kubernetes/{self.environment}/{self.application}/values.yaml":
            raise ValueError("values path does not match application")
        if self.event.startswith("sync_") and self.operation_started_at is None:
            raise ValueError("sync notifications require the operation identity")
        if self.event == "deleting" and self.deletion_started_at is None:
            raise ValueError("deleting requires deletionTimestamp")
        for point in (self.operation_started_at, self.operation_finished_at, self.deletion_started_at, self.health_changed_at):
            if point is not None and point < self.application_created_at:
                raise ValueError("event predates Application creation")
        if self.operation_finished_at and (not self.operation_started_at or self.operation_finished_at < self.operation_started_at):
            raise ValueError("operation finish predates start")
        return self


def ingest(store, event: ArgoNotification, source_name, integration, now=None, clock_skew=300):
    now = time.time() if now is None else now
    if (event.source != source_name or integration.kind != "argocd"
            or event.project not in integration.projects or event.environment not in integration.environments):
        raise Rejected("notification_scope_denied", 403)
    points = [event.application_created_at, event.operation_started_at, event.operation_finished_at, event.deletion_started_at, event.health_changed_at]
    if any(point and point.timestamp() > now + clock_skew for point in points):
        raise Rejected("event_time_in_future", 422)
    payload = event.model_dump(mode="json")
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    fingerprint = sha256(canonical.encode()).hexdigest()
    # Identity is determined here, never chosen by a caller or generated with a GitLab job ID.
    identity = [source_name, str(event.application_uid), event.resource_version, event.event, event.revisions]
    event_id = str(uuid5(NAMESPACE_URL, json.dumps(identity, separators=(",", ":"))))
    producer = f"argocd:{source_name}"
    with store.engine.begin() as conn:
        registration = conn.execute(select(services).where(services.c.project == event.source_project,
            services.c.active.is_(True)).with_for_update()).mappings().first()
        if registration is None:
            raise Rejected("service_not_registered", 403)
        duplicate = conn.execute(select(events).where(events.c.producer == producer,
            events.c.event_id == event_id)).mappings().first()
        if duplicate:
            if duplicate["fingerprint"] != fingerprint:
                raise Rejected("event_id_conflict")
            return {"event_id": event_id, "duplicate": True, "applied": False}
        key, _ = store.instance_identity(conn, registration, event.environment, event.source_ref, event.application)
        conn.execute(events.insert().values(producer=producer, event_id=event_id, service=registration["key"],
            instance_id=key, kind="argocd_notification", payload=payload, fingerprint=fingerprint,
            received_at=now, applied=False))
        store.ensure_source(conn, source_name)
        last = conn.execute(select(sources.c.last_success_at).where(sources.c.name == source_name).with_for_update()).scalar() or 0
        store.schedule(conn, source_name, now + 15, last + 60)
        store.request_application(conn, source_name, event.application, now)
    return {"event_id": event_id, "duplicate": False, "applied": False}
