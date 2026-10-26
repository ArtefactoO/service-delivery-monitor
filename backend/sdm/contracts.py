from datetime import datetime, timezone
from hashlib import sha256
import re
from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SHA = Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]
Name = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(Model):
    project_id: int = Field(gt=0)
    ref: str = Field(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f]+$")
    revision: SHA


Environment = Literal["test", "preprod", "prod", "feature"]
ENVIRONMENTS = get_args(Environment)


class Target(Model):
    environment: Environment
    instance: Name


class Attempt(Model):
    project_id: int = Field(gt=0)
    pipeline_id: int = Field(gt=0)
    job_id: int = Field(gt=0)
    # Monotonic within this job, e.g. started=0 and terminal result=1.
    sequence: int = Field(ge=0, le=1_000_000)


class Image(Model):
    repository: str = Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]+$")
    digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")


class Publication(Model):
    revision: SHA
    values_path: str = Field(max_length=512, pattern=r"^kubernetes/(test|preprod|prod|feature)/[a-z0-9-]+/values\.yaml$")
    values_revision: SHA
    build_revision: SHA
    images: list[Image] = Field(min_length=1, max_length=32)
    config_revision: SHA | None = None
    chart_ref: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._/-]+$")

    @model_validator(mode="after")
    def unique_images(self):
        if len({item.repository for item in self.images}) != len(self.images):
            raise ValueError("duplicate image repository")
        return self


class Runtime(Model):
    application: Name
    application_uid: UUID
    application_created_at: datetime
    namespace: Name
    # A reported verification is separate from the current Argo observation.
    verified_at: datetime | None = None
    auto_stop_at: datetime | None = None

    @field_validator("application_created_at", "verified_at", "auto_stop_at")
    @classmethod
    def aware(cls, value):
        if value is not None and value.utcoffset() is None:
            raise ValueError("timezone is required")
        return value.astimezone(timezone.utc) if value else None

    @model_validator(mode="after")
    def chronological(self):
        if self.verified_at and self.verified_at < self.application_created_at:
            raise ValueError("verification cannot precede Application creation")
        return self


class DeliveryEvent(Model):
    schema_version: Literal[1]
    event_id: UUID
    kind: Literal["build", "publication", "deployment", "argocd"]
    status: Literal["started", "succeeded", "failed", "canceled"]
    action: Literal["upsert", "delete"] = "upsert"
    service: Name
    source: Source
    attempt: Attempt
    occurred_at: datetime
    target: Target | None = None
    publication: Publication | None = None
    runtime: Runtime | None = None
    images: list[Image] = Field(default_factory=list, max_length=32)
    build_revision: SHA | None = None
    absence_confirmed: bool = False
    # A stable non-secret reason code, never job output or arbitrary error text.
    failure_code: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_.-]{0,79}$")

    @field_validator("occurred_at")
    @classmethod
    def aware(cls, value):
        if value.utcoffset() is None:
            raise ValueError("timezone is required")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def consistent(self):
        if self.target and self.target.environment == "feature" and not re.fullmatch(r"feature/[A-Za-z0-9][A-Za-z0-9._/-]*", self.source.ref):
            raise ValueError("feature target requires feature/* branch")
        if self.kind == "build":
            if self.target or self.publication or self.runtime or self.action != "upsert":
                raise ValueError("build is branch-scoped, without deployment target")
            if self.status == "succeeded" and not self.images:
                raise ValueError("successful build requires images")
        elif not self.target:
            raise ValueError("target is required")
        if self.action == "delete" and (self.kind not in {"publication", "deployment"} or self.target.environment != "feature"):
            raise ValueError("only feature publication/deployment can delete")
        if self.kind in {"publication", "deployment"} and self.status == "succeeded" and self.action == "upsert" and not self.publication:
            raise ValueError("successful publication/deployment requires immutable publication metadata")
        if self.kind == "deployment" and self.status == "succeeded":
            if not (self.action == "delete" and self.absence_confirmed) and (not self.runtime or not self.runtime.verified_at):
                raise ValueError("successful deployment requires runtime verification")
        if self.absence_confirmed and not (self.kind == "deployment" and self.status == "succeeded"
                and self.action == "delete" and self.runtime is None):
            raise ValueError("absence confirmation is only for a verified feature deletion without a known UID")
        if self.kind != "build" and self.images:
            raise ValueError("deployment images belong inside publication metadata")
        if self.build_revision and self.kind != "build":
            raise ValueError("build revision belongs to build events")
        if self.runtime and self.runtime.verified_at and self.runtime.verified_at > self.occurred_at:
            raise ValueError("verification cannot follow event time")
        if self.runtime and self.target and self.runtime.application != self.target.instance:
            raise ValueError("runtime Application must match target instance")
        if self.publication and self.target and self.publication.values_path != f"kubernetes/{self.target.environment}/{self.target.instance}/values.yaml":
            raise ValueError("values path must match target")
        if self.status in {"failed", "canceled"} and not self.failure_code:
            raise ValueError("failure/cancellation requires a reason code")
        if self.status not in {"failed", "canceled"} and self.failure_code:
            raise ValueError("failure code on a successful or running event")
        return self


def feature_id(service: str, project: str, ref: str) -> str:
    """New publisher name; ownership still requires the complete project/ref identity."""
    if not re.fullmatch(r"feature/[A-Za-z0-9][A-Za-z0-9._/-]*", ref):
        raise ValueError("feature target requires feature/* branch")
    slug = "ft-" + re.sub(r"[^a-z0-9]+", "-", ref[len("feature/"):].lower()).strip("-")
    remaining = 49 - len(slug) - 1
    if remaining < 1:
        raise ValueError("feature branch leaves no space for the service name")
    return f"{slug}-{service[:remaining].rstrip('-')}"


def expected_instance(service: str, project: str, environment: str, ref: str) -> str:
    if environment == "feature":
        if not re.fullmatch(r"feature/[A-Za-z0-9][A-Za-z0-9._/-]*", ref):
            raise ValueError("feature target requires feature/* branch")
        return feature_id(service, project, ref)
    return service + "-preprod" if environment == "preprod" else service


def _previous_feature_id(service: str, project: str, ref: str) -> str:
    """Exact validation of persisted names emitted before full branch names."""
    slug = re.sub(r"[^a-z0-9]+", "-", ref.lower()).strip("-")
    digest = sha256(f"{project}\0{ref}".encode()).hexdigest()[:8]
    return f"ft-{service[:18].rstrip('-')}-{slug[:15].rstrip('-')}-{digest}"


def matches_instance(service: str, project: str, environment: str, ref: str, name: str) -> bool:
    if environment == "feature":
        if not re.fullmatch(r"feature/[A-Za-z0-9][A-Za-z0-9._/-]*", ref):
            return False
        if name == _previous_feature_id(service, project, ref):
            return True
    try:
        return name == expected_instance(service, project, environment, ref)
    except ValueError:
        return False
