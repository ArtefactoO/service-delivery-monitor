"""GitLab CI JWTs: offline verification against a budgeted background JWKS cache."""
import re
import time
from dataclasses import dataclass

from fastapi import HTTPException
from joserfc import jwt
from joserfc.jwk import KeySet
from joserfc.jwt import JWTClaimsRegistry
from sqlalchemy import select

from .config import Producer
from .store import ci_keys, services, sources


@dataclass
class CIJob:
    claims: dict


def refresh_registry(config, store):
    with store.engine.begin() as conn:
        store.ensure_source(conn, config.gitlab_source)
        last = conn.execute(select(sources.c.last_success_at).where(sources.c.name == config.gitlab_source).with_for_update()).scalar() or 0
        store.schedule(conn, config.gitlab_source, time.time() + 15, last + 60)


def authenticate(token, config, store, now=None):
    now = time.time() if now is None else now
    if not config or len(token) > 16384:
        raise HTTPException(401, "invalid_ci_identity")
    with store.engine.connect() as conn:
        keys = conn.execute(select(ci_keys).where(ci_keys.c.issuer == config.issuer)).mappings().first()
    if not keys or now - keys["fetched_at"] > config.jwks_ttl_seconds:
        raise HTTPException(503, "ci_keys_unavailable", headers={"Retry-After": "60"})
    try:
        decoded = jwt.decode(token, KeySet.import_key_set(keys["jwks"]), algorithms=["RS256"])
        JWTClaimsRegistry(now=lambda: int(now), leeway=30,
            iss={"essential": True, "value": config.issuer}, aud={"essential": True, "value": config.audience},
            exp={"essential": True}, nbf={"essential": True}, iat={"essential": True},
            sub={"essential": True}, jti={"essential": True}).validate(decoded.claims)
        c = decoded.claims
        for key in ["project_id", "pipeline_id", "job_id"]:
            if not re.fullmatch(r"[1-9][0-9]*", str(c[key])):
                raise ValueError("invalid CI identity")
        if c.get("ref_type") != "branch" or not c.get("pipeline_source") or c.get("pipeline_source") in {"merge_request_event", "external_pull_request_event"}:
            raise ValueError("unsupported CI context")
        if c.get("job_project_id") is not None and str(c["job_project_id"]) != str(c["project_id"]):
            raise ValueError("source and job project mismatch")
        if not re.fullmatch(r"[a-f0-9]{40}", c.get("sha", "")):
            raise ValueError("CI SHA is missing")
        return CIJob(c)
    except Exception:
        raise HTTPException(401, "invalid_ci_identity") from None


def policy(event, identity, config, store):
    c = identity.claims
    if (event.attempt.project_id != int(c["project_id"]) or event.attempt.pipeline_id != int(c["pipeline_id"])
            or event.attempt.job_id != int(c["job_id"])):
        raise HTTPException(403, "ci_job_mismatch")
    project_id = int(c["project_id"])
    if project_id == config.publisher_project_id:
        if (c.get("ref") != config.publisher_ref or c.get("ref_protected") not in (True, "true")
                or c.get("pipeline_source") not in {"pipeline", "trigger"}):
            raise HTTPException(403, "publisher_context_denied")
        job_environment = c.get("environment")
        target = event.target.environment if event.target else None
        if target in {"preprod", "prod"}:
            expected = "production/" + event.service + ("-preprod" if target == "preprod" else "")
            if job_environment != expected:
                raise HTTPException(403, "publisher_environment_denied")
        elif job_environment is not None and (not isinstance(job_environment, str)
                or job_environment.lower().split("/", 1)[0] == "production"):
            raise HTTPException(403, "publisher_environment_denied")
        return f"gitlab-ci:publisher:{project_id}", Producer(token_env="", kinds=["publication", "deployment", "argocd"],
            all_registered_projects=True, attempt_project_id=project_id, environments=["test", "feature", "preprod", "prod"])
    if (event.kind != "build" or event.source.project_id != project_id or event.source.ref != c.get("ref")
            or event.source.revision != c["sha"]):
        raise HTTPException(403, "ci_build_scope_denied")
    with store.engine.connect() as conn:
        registration = conn.execute(select(services).where(services.c.key == event.service)).mappings().first()
    if not registration:
        refresh_registry(config, store)
        raise HTTPException(503, "registry_not_ready", headers={"Retry-After": "60"})
    if not registration["active"] or registration["project_id"] != project_id or registration["project"] != c.get("project_path"):
        raise HTTPException(403, "ci_service_not_registered")
    return f"gitlab-ci:build:{project_id}", Producer(token_env="", kinds=["build"],
        source_project_ids=[project_id], attempt_project_id=project_id)
