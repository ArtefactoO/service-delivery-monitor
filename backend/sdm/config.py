import json
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator

from .contracts import Model


def secret(name: str, min_length: int = 1) -> str:
    value = os.environ.get(name, "")
    file = os.environ.get(name + "_FILE")
    if file:
        value = Path(file).read_text().strip()
    if len(value) < min_length:
        raise ValueError(f"{name} must contain at least {min_length} characters")
    return value


class Producer(Model):
    token_env: str
    kinds: list[Literal["build", "publication", "deployment", "argocd"]]
    source_project_ids: list[int] = Field(default_factory=list)
    all_registered_projects: bool = False
    attempt_project_id: int
    environments: list[str] = Field(default_factory=lambda: ["test", "feature"])


class Integration(Model):
    kind: Literal["gitlab", "argocd"]
    base_url: str
    token_env: str
    interval_seconds: int = Field(default=600, ge=300)
    min_request_interval_seconds: float = Field(default=2, ge=0.1)
    requests_per_window: int = Field(default=30, ge=1, le=120)
    window_seconds: int = Field(default=300, ge=60)
    timeout_seconds: float = Field(default=10, gt=0, le=30)
    project_id: int | None = None
    ref: str = "main"
    registry_path: str = "ci/publish.py"
    projects: list[str] = Field(default_factory=list)
    environments: list[str] = Field(default_factory=list)
    deployment_repo_url: str | None = None
    gitlab_source: str | None = None
    runtime_enabled: bool = False
    runtime_max_resources: int = Field(default=200, ge=1, le=1000)
    notification_token_env: str | None = None

    @field_validator("base_url")
    @classmethod
    def https_only(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("integration requires a fixed HTTPS base URL without credentials")
        return value.rstrip("/")

    @model_validator(mode="after")
    def scope(self):
        if self.notification_token_env and self.kind != "argocd":
            raise ValueError("notification tokens belong to Argo integrations")
        if self.kind == "gitlab" and not self.project_id:
            raise ValueError("GitLab publisher project_id is required")
        if self.kind == "argocd" and (not self.projects or not self.environments or not self.deployment_repo_url):
            raise ValueError("Argo projects, environments and deployment repository are required")
        return self


class OIDC(Model):
    issuer: str
    public_url: str
    client_id_env: str = "SDM_OIDC_CLIENT_ID"
    client_secret_env: str = "SDM_OIDC_CLIENT_SECRET"
    session_seconds: int = Field(default=86400, ge=300, le=86400)

    @field_validator("issuer", "public_url")
    @classmethod
    def https_url(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("OIDC requires a fixed HTTPS URL")
        return value

    @model_validator(mode="after")
    def origin_only(self):
        if urlsplit(self.public_url).path not in {"", "/"}:
            raise ValueError("public_url must be an origin")
        self.public_url = self.public_url.rstrip("/")
        self.issuer = self.issuer.rstrip("/") + "/"
        return self


class CIIdentity(Model):
    issuer: str
    audience: str
    gitlab_source: str
    publisher_project_id: int = Field(gt=0)
    publisher_ref: str = "main"
    jwks_ttl_seconds: int = Field(default=3600, ge=300, le=3600)

    @field_validator("issuer", "audience")
    @classmethod
    def https(cls, value):
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("CI identity requires a fixed HTTPS URL")
        return value.rstrip("/")


class Settings(Model):
    database_url: str
    reader_token_env: str = "SDM_READER_TOKEN"
    producers: dict[str, Producer]
    integrations: dict[str, Integration] = Field(default_factory=dict)
    teams: dict[str, str] = Field(default_factory=dict)
    bootstrap_registry: str | None = None
    frontend_dir: str | None = "/app/static"
    reconcile_enabled: bool = True
    request_body_bytes: int = Field(default=262144, ge=1024, le=1048576)
    event_clock_skew_seconds: int = 300
    oidc: OIDC | None = None
    vault_stores: dict[str, dict[str, str]] = Field(default_factory=dict)
    ci_identity: CIIdentity | None = None

    @field_validator("database_url")
    @classmethod
    def postgres(cls, value):
        if not value.startswith("postgresql+psycopg://"):
            raise ValueError("PostgreSQL with psycopg is required")
        return value

    @model_validator(mode="after")
    def unique_integration_hosts(self):
        bases = [(urlsplit(item.base_url).hostname, urlsplit(item.base_url).port or 443)
                 for item in self.integrations.values()]
        if len(set(bases)) != len(bases):
            raise ValueError("one integration budget per origin is required")
        for item in self.integrations.values():
            if item.gitlab_source and (item.gitlab_source not in self.integrations or self.integrations[item.gitlab_source].kind != "gitlab"):
                raise ValueError("unknown GitLab source")
        if self.ci_identity:
            source = self.integrations.get(self.ci_identity.gitlab_source)
            if not source or source.kind != "gitlab" or source.base_url != self.ci_identity.issuer:
                raise ValueError("CI identity must share the configured GitLab origin and budget")
        return self


def load_settings() -> Settings:
    raw = json.loads(Path(os.environ["SDM_CONFIG"]).read_text())
    raw["database_url"] = secret("DATABASE_URL")
    settings = Settings.model_validate(raw)
    secret(settings.reader_token_env, 32)
    for producer in settings.producers.values():
        secret(producer.token_env, 32)
    for integration in settings.integrations.values():
        if integration.notification_token_env:
            secret(integration.notification_token_env, 32)
    return settings
