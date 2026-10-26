"""Content-addressed metadata; moving repository HEAD cannot invalidate every file."""
import json
import re
from urllib.parse import quote

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert

from .reconcile_errors import SourceFailure
from .store import repository_trees, value_metadata

SHA = re.compile(r"[a-f0-9]{40}")
VALUES_PATH = re.compile(r"kubernetes/(?:test|preprod|prod|feature)/[a-z0-9-]+/values\.yaml")
PROJECTION_VERSION = 4


def file_blob(worker, source, revision, path):
    if not isinstance(revision, str) or not SHA.fullmatch(revision) or not VALUES_PATH.fullmatch(path):
        raise SourceFailure("invalid_values_identity")
    config = worker.settings.integrations[source]
    key = (repository_trees.c.source == source) & (repository_trees.c.project_id == config.project_id) & (repository_trees.c.revision == revision)
    with worker.store.engine.begin() as conn:
        conn.execute(insert(repository_trees).values(source=source, project_id=config.project_id, revision=revision,
                     used_at=worker.clock()).on_conflict_do_nothing())
        row = dict(conn.execute(select(repository_trees).where(key)).mappings().one())
        conn.execute(update(repository_trees).where(key).values(used_at=worker.clock()))
    while not row["complete"]:
        if row["page"] > 100:
            raise SourceFailure("repository_tree_limit")
        body, _ = worker.get(source, f"/api/v4/projects/{config.project_id}/repository/tree",
                             params={"path": "kubernetes", "ref": revision, "recursive": "true", "per_page": 100, "page": row["page"]})
        entries = json.loads(body)
        if not isinstance(entries, list) or len(entries) > 100:
            raise SourceFailure("invalid_repository_tree")
        files = dict(row["files"])
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("type") not in {"tree", "blob", "commit"}:
                raise SourceFailure("invalid_repository_tree")
            candidate = entry.get("path")
            if entry["type"] == "blob" and isinstance(candidate, str) and VALUES_PATH.fullmatch(candidate):
                blob = entry.get("id")
                if not isinstance(blob, str) or not SHA.fullmatch(blob):
                    raise SourceFailure("invalid_repository_tree")
                if candidate in files and files[candidate] != blob:
                    raise SourceFailure("invalid_repository_tree")
                files[candidate] = blob
        if len(files) > 5000:
            raise SourceFailure("repository_tree_limit")
        row.update(files=files, page=row["page"] + 1, complete=len(entries) < 100)
        with worker.store.engine.begin() as conn:
            conn.execute(update(repository_trees).where(key).values(files=files, page=row["page"],
                         complete=row["complete"], used_at=worker.clock()))
    blob = row["files"].get(path)
    if not blob:
        raise SourceFailure("values_file_not_in_inventory")
    return blob


def cache_projection(worker, source, blob, projection):
    config = worker.settings.integrations[source]
    with worker.store.engine.begin() as conn:
        conn.execute(insert(value_metadata).values(source=source, project_id=config.project_id, blob=blob,
                     projection=projection, used_at=worker.clock()).on_conflict_do_update(
                         index_elements=["source", "project_id", "blob"],
                         set_={"projection": projection, "used_at": worker.clock()}))


def values_projection(worker, integration, app, recorded, project):
    if not integration.gitlab_source:
        raise SourceFailure("gitlab_source_required")
    source, revision, path = integration.gitlab_source, app["values_revision"], app["values_path"]
    same = recorded.get("git") if recorded.get("values_revision") == revision else None
    if same and same.get("projection_version") == PROJECTION_VERSION and recorded.get("values_blob"):
        app["_values_blob"] = recorded["values_blob"]
        return same
    # Seed pre-upgrade observations from their own immutable tree, without re-reading values.
    prior = recorded.get("git") or {}
    if prior.get("projection_version") == PROJECTION_VERSION and not recorded.get("values_blob") and SHA.fullmatch(recorded.get("values_revision") or ""):
        old_blob = file_blob(worker, source, recorded["values_revision"], path)
        cache_projection(worker, source, old_blob, prior)
    blob = file_blob(worker, source, revision, path)
    app["_values_blob"] = blob
    if blob == recorded.get("values_blob") and prior.get("projection_version") == PROJECTION_VERSION:
        cache_projection(worker, source, blob, prior)
        return prior
    config = worker.settings.integrations[source]
    with worker.store.engine.begin() as conn:
        key = (value_metadata.c.source == source) & (value_metadata.c.project_id == config.project_id) & (value_metadata.c.blob == blob)
        cached = conn.execute(select(value_metadata.c.projection).where(key)).scalar()
        if cached and cached.get("projection_version") == PROJECTION_VERSION:
            conn.execute(update(value_metadata).where(key).values(used_at=worker.clock()))
            return cached
    body, _ = worker.get(source, f"/api/v4/projects/{config.project_id}/repository/files/{quote(path, safe='')}/raw", params={"ref": revision})
    projection = project(body)
    cache_projection(worker, source, blob, projection)
    return projection


def prune(store, now):
    # Only reconstructible metadata is expired. Receipts, archives and observations are untouched.
    with store.engine.begin() as conn:
        for table in (repository_trees, value_metadata):
            conn.execute(delete(table).where(table.c.used_at < now - 7 * 86400))
