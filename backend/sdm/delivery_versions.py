"""Versions tied to an observed build and release operation, never repository HEAD."""
import hashlib
import json
import re
from urllib.parse import quote

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
import yaml

from .reconcile_errors import SourceFailure
from .store import value_metadata

CI_PROJECT = "platform/ci-cd"
SHA = re.compile(r"[a-f0-9]{40}")
OPERATION = re.compile(r"[a-f0-9]{64}")
TAG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}")
RETRY_SECONDS = 600
MAX_TAG_PAGES = 10


def metadata_failure(worker, source, error, fallback):
    if isinstance(error, SourceFailure):
        if worker.origin_failure(error.code):
            worker.fail_source(source, error)
        return error.code
    return fallback


def cache_key(kind, identity):
    return hashlib.sha1(json.dumps(["delivery-versions", kind, identity], sort_keys=True).encode()).hexdigest()


def cached(worker, source, kind, identity):
    config = worker.settings.integrations[source]
    key = ((value_metadata.c.source == source) & (value_metadata.c.project_id == config.project_id)
           & (value_metadata.c.blob == cache_key(kind, identity)))
    with worker.store.engine.begin() as conn:
        row = conn.execute(select(value_metadata.c.projection).where(key)).scalar()
        if row and row.get("kind") == kind and row.get("identity") == identity:
            conn.execute(update(value_metadata).where(key).values(used_at=worker.clock()))
            return row
    return {}


def remember(worker, source, kind, identity, **data):
    config = worker.settings.integrations[source]
    row = {"kind": kind, "identity": identity, "checked_at": worker.clock(), **data}
    with worker.store.engine.begin() as conn:
        conn.execute(insert(value_metadata).values(source=source, project_id=config.project_id,
            blob=cache_key(kind, identity), projection=row, used_at=worker.clock()).on_conflict_do_update(
                index_elements=["source", "project_id", "blob"], set_={"projection": row, "used_at": worker.clock()}))
    return row


def ci_pin(content):
    config = yaml.safe_load(content)
    if not isinstance(config, dict):
        raise ValueError("invalid CI config")
    includes = config.get("include") or []
    includes = includes if isinstance(includes, list) else [includes]
    refs = {entry.get("ref") for entry in includes if isinstance(entry, dict) and entry.get("project") == CI_PROJECT
            and isinstance(entry.get("ref"), str)}
    if len(refs) != 1:
        return None
    ref = refs.pop()
    if not TAG.fullmatch(ref) or ".." in ref or "//" in ref:
        return None
    return {"project": CI_PROJECT, "ref": ref}


def build_ci(worker, source, project, revision):
    identity = [project, revision]
    row = cached(worker, source, "ci-pin", identity)
    if row.get("complete") and not row.get("error"):
        return row.get("value"), None
    if row and worker.clock() < row["checked_at"] + RETRY_SECONDS:
        return None, row.get("error")
    try:
        body, _ = worker.get(source, f"/api/v4/projects/{quote(project, safe='')}/repository/files/.gitlab-ci.yml/raw",
                             params={"ref": revision})
        value = ci_pin(body)
        if value:
            value["revision"] = revision
        remember(worker, source, "ci-pin", identity, complete=True, value=value)
        return value, None
    except (SourceFailure, ValueError, TypeError, yaml.YAMLError) as error:
        code = metadata_failure(worker, source, error, "invalid_ci_config")
        remember(worker, source, "ci-pin", identity, error=code)
        return None, code


def release_tag(tag, service, projection):
    if not isinstance(tag, dict) or not isinstance(tag.get("message"), str):
        return None
    records = [line.removeprefix("Delivery-Release: ") for line in tag["message"].splitlines()
               if line.startswith("Delivery-Release: ")]
    if len(records) != 1 or len(records[0]) > 65536:
        return None
    try:
        record = json.loads(records[0])
    except ValueError:
        return None
    if not isinstance(record, dict):
        return None
    images = {image["repository"]: image["digest"] for image in projection["images"]}
    name = tag.get("name")
    commit = tag.get("commit") if isinstance(tag.get("commit"), dict) else {}
    publication = record.get("publication_revision")
    fingerprint = record.get("values_sha256")
    if (record.get("schema") != 1 or record.get("id") != projection["release_operation"]
            or record.get("scope") != f"{service['project_id']}:{service['key']}:prod"
            or str(record.get("project")) != str(service["project_id"]) or record.get("service") != service["key"]
            or record.get("sha") != projection["build_revision"] or commit.get("id") != record.get("sha")
            or record.get("images") != images or record.get("tag") != name
            or not isinstance(name, str) or not TAG.fullmatch(name) or ".." in name or "//" in name
            or not isinstance(record.get("version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+", record["version"])
            or not isinstance(publication, str) or not SHA.fullmatch(publication)
            or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)):
        return None
    return {"tag": name, "version": record["version"], "operation": record["id"], "revision": record["sha"]}


def registered_release(worker, source, service, projection):
    identity = [service["project_id"], service["key"], projection["release_operation"],
                projection["build_revision"], projection["images"]]
    row = cached(worker, source, "release-tag", identity)
    if row.get("value"):
        return row["value"], None
    if row.get("complete") and worker.clock() < row["checked_at"] + RETRY_SECONDS:
        return None, row.get("error")
    page = row.get("page", 1) if not row.get("complete") else 1
    try:
        while page <= MAX_TAG_PAGES:
            body, _ = worker.get(source, f"/api/v4/projects/{service['project_id']}/repository/tags",
                                 params={"per_page": 100, "page": page})
            tags = json.loads(body)
            if not isinstance(tags, list) or len(tags) > 100:
                raise ValueError("invalid tags")
            matches = [value for tag in tags if (value := release_tag(tag, service, projection))]
            if len(matches) > 1:
                raise ValueError("ambiguous release tags")
            if matches:
                remember(worker, source, "release-tag", identity, complete=True, value=matches[0])
                return matches[0], None
            if len(tags) < 100:
                remember(worker, source, "release-tag", identity, complete=True, error="release_tag_not_registered")
                return None, "release_tag_not_registered"
            page += 1
            remember(worker, source, "release-tag", identity, page=page)
        raise ValueError("release tag search limit")
    except (SourceFailure, ValueError, TypeError) as error:
        code = metadata_failure(worker, source, error, "invalid_release_tags")
        remember(worker, source, "release-tag", identity, complete=True, error=code)
        return None, code


def enrich(worker, integration, app, projection, service):
    result = {**projection}
    result.pop("ci", None)
    result.pop("release", None)
    result.pop("version_errors", None)
    source = integration.gitlab_source
    revision = projection.get("build_revision")
    if not source or not service or not isinstance(revision, str) or not SHA.fullmatch(revision):
        return result
    ci, ci_error = build_ci(worker, source, service["project"], revision)
    errors = {}
    if ci:
        result["ci"] = ci
    if ci_error:
        errors["ci"] = ci_error
    operation = projection.get("release_operation")
    if app["environment"] == "prod" and isinstance(operation, str) and OPERATION.fullmatch(operation):
        release, release_error = registered_release(worker, source, service, projection)
        if release:
            result["release"] = release
        if release_error:
            errors["release"] = release_error
    if errors:
        result["version_errors"] = errors
    return result
