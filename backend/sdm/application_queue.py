"""Durable, fair application checks. Events enqueue hints, never observed status."""
from datetime import datetime
from math import ceil

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert

from .reconcile_errors import Deferred, SourceFailure, Superseded
from .store import application_checks as checks, instances, iso, observation_matches_lifecycle, sources


def identity(snapshot):
    return tuple(snapshot.get(key) for key in ("uid", "namespace", "project", "values_path"))


def resource_interval(config, count):
    # Reserve one fifth of the shared budget for events and discovery; no budget is raised here.
    if not config.runtime_enabled:
        return config.interval_seconds
    return max(config.interval_seconds, ceil((count + 1) * config.window_seconds / (config.requests_per_window * .8)))


def enqueue_inventory(worker, source, snapshots, listed, errors, observed_at, uncertain=()):
    now = worker.clock()
    names = {item["name"] for item in listed} | set(uncertain)
    by_name = {item["name"]: item for item in snapshots}
    with worker.store.engine.begin() as conn:
        previous = {row["name"]: dict(row) for row in conn.execute(select(checks).where(checks.c.source == source)).mappings()}
        for snapshot in snapshots:
            name = snapshot["name"]
            old = previous.get(name)
            prior = (old or {}).get("snapshot") or {}
            reusable = bool(old and prior and identity(prior) == identity(snapshot))
            progress = dict(old["progress"]) if reusable else {}
            if prior.get("values_revision") != snapshot.get("values_revision"):
                for key in ("_git", "_git_revision", "_values_blob"):
                    progress.pop(key, None)
            significant = not prior or any(prior.get(k) != snapshot.get(k) for k in
                ("uid", "namespace", "project", "values_path", "chart_repo", "chart_ref", "sync", "health", "resources"))
            changed = prior != snapshot
            retry_changed = bool(changed and old and old["error_code"])
            metadata_changed = prior.get("values_revision") != snapshot.get("values_revision")
            query = insert(checks).values(source=source, name=name, snapshot=snapshot, snapshot_at=observed_at,
                         progress=progress, due_at=now, priority=significant, version=1)
            conn.execute(query.on_conflict_do_update(index_elements=["source", "name"], set_={
                "snapshot": snapshot, "snapshot_at": observed_at, "progress": progress,
                "version": checks.c.version + (1 if changed else 0),
                "due_at": func.least(checks.c.due_at, now) if significant or retry_changed or metadata_changed else checks.c.due_at,
                "priority": checks.c.priority | (significant or retry_changed),
                "error_code": None if changed else checks.c.error_code,
                "started_at": checks.c.started_at if reusable else None,
                "runtime_due_at": checks.c.runtime_due_at if reusable else None,
            }))
        for name, code in errors.items():
            if not isinstance(name, str) or not name or len(name) > 63:
                continue
            conn.execute(insert(checks).values(source=source, name=name, snapshot=None, due_at=now,
                         error_code=code).on_conflict_do_update(index_elements=["source", "name"],
                         set_={"snapshot": None, "error_code": code, "version": checks.c.version + 1}))
        # A notification arriving during the list request retains its discovery hint.
        conn.execute(delete(checks).where(checks.c.source == source, checks.c.name.not_in(names),
                     func.coalesce(checks.c.requested_at, 0) <= observed_at))
    with worker.store.engine.begin() as conn:
        for found in conn.execute(select(instances).where(instances.c.environment.in_(worker.settings.integrations[source].environments))
                                  .with_for_update()).mappings():
            previous = found["observations"].get(source)
            if not previous:
                continue
            if found["lifecycle"].get("stopped_at") or (previous.get("uid") and not observation_matches_lifecycle(found, previous)):
                continue
            if found["name"] in uncertain:
                conn.execute(update(instances).where(instances.c.id == found["id"]).values(observations={
                    **found["observations"], source: {**previous, "collection_error": {
                        "code": errors[found["name"]], "checked_at": iso(observed_at)}}}))
                continue
            present = any(item.get("uid") == previous.get("uid") and item.get("name") == previous.get("name")
                          and item.get("project") == previous.get("project") for item in listed)
            observation = {**previous, "present": present, "presence_checked_at": iso(observed_at)}
            current = by_name.get(found["name"])
            if current and present and identity(current) == identity(previous):
                # Inventory status is published independently of slower Pod/manifest checks.
                observation.update({key: current[key] for key in ("sync", "health", "resources")})
                observation["inventory_observed_at"] = iso(observed_at)
            if present and found["name"] in errors:
                observation["collection_error"] = {"code": errors[found["name"]], "checked_at": iso(observed_at)}
            elif not present:
                observation.pop("collection_error", None)
            conn.execute(update(instances).where(instances.c.id == found["id"]).values(
                observations={**found["observations"], source: observation}))


def migrate_legacy(worker, source):
    previous = worker.source_state(source)["state"]
    if "pending" not in previous:
        return
    observed_at = datetime.fromisoformat(previous["observed_at"]).timestamp()
    pending = previous["pending"]
    with worker.store.engine.begin() as conn:
        for app in pending:
            snapshot = {k: v for k, v in app.items() if not k.startswith("_")}
            progress = {k: v for k, v in app.items() if k in {"_git", "_runtime", "_values_blob", "_git_revision"}}
            if "_git" in progress:
                progress["_git_revision"] = app.get("values_revision")
            conn.execute(insert(checks).values(source=source, name=app["name"], snapshot=snapshot,
                         snapshot_at=observed_at, progress=progress, due_at=worker.clock()).on_conflict_do_nothing())
        conn.execute(update(sources).where(sources.c.name == source).values(state={
            k: v for k, v in previous.items() if k not in {"pending", "listed", "seen", "observed_at"}}))


def choose(worker, eligible):
    candidates = []
    with worker.store.engine.connect() as conn:
        for source in eligible:
            if worker.settings.integrations[source].kind != "argocd":
                continue
            state = conn.execute(select(sources.c.state).where(sources.c.name == source)).scalar() or {}
            # One of four turns is reserved for ordinary checks, even in a notification storm.
            ordinary = state.get("runtime_turn", 0) % 4 == 3
            rank = case((checks.c.priority == (not ordinary), 0), else_=1)
            row = conn.execute(select(checks).where(checks.c.source == source, checks.c.snapshot.is_not(None),
                checks.c.snapshot_at >= func.coalesce(checks.c.requested_at, 0),
                checks.c.due_at <= worker.clock()).order_by(rank, checks.c.last_step_at, checks.c.due_at, checks.c.name).limit(1)).mappings().first()
            if row:
                candidates.append(dict(row))
    if not candidates:
        return None
    row = min(candidates, key=lambda r: (r["last_step_at"], r["due_at"], r["source"]))
    with worker.store.engine.begin() as conn:
        state = dict(conn.execute(select(sources.c.state).where(sources.c.name == row["source"]).with_for_update()).scalar() or {})
        state["runtime_turn"] = (state.get("runtime_turn", 0) + 1) % 4
        conn.execute(update(sources).where(sources.c.name == row["source"]).values(state=state))
        conn.execute(update(checks).where(checks.c.source == row["source"], checks.c.name == row["name"]).values(
            last_step_at=worker.clock(), started_at=func.coalesce(checks.c.started_at, worker.clock())))
    row["started_at"] = row["started_at"] if row["started_at"] is not None else worker.clock()
    return row


def run(worker, row):
    source, config, now = row["source"], worker.settings.integrations[row["source"]], worker.clock()
    key = (checks.c.source == source) & (checks.c.name == row["name"]) & (checks.c.version == row["version"])
    app = {**row["snapshot"], **row["progress"]}
    state = {"observed_at": iso(row["snapshot_at"]), "seen": [], "ignored": 0, "_check": row}
    count = worker.source_state(source)["state"].get("count", 0)
    interval = resource_interval(config, count)
    state["_check_interval"] = interval
    state["_allow_cached_runtime"] = bool(row["runtime_due_at"] and row["runtime_due_at"] > now
                                         and not row["priority"] and not row["progress"].get("_runtime"))

    def checkpoint():
        progress = {k: v for k, v in app.items() if k in {"_git", "_git_revision", "_values_blob", "_runtime"}}
        with worker.store.engine.begin() as conn:
            if not conn.execute(update(checks).where(key).values(progress=progress)).rowcount:
                raise Superseded()

    try:
        if not app.get("values_revision"):
            raise SourceFailure("unresolved_values_revision")
        worker.collect_application(source, app, state, checkpoint)
        finished = worker.clock()
        metadata_only = state.get("_metadata_only", False)
        next_due = row["runtime_due_at"] if metadata_only else max(
            row["started_at"] + interval + worker.jitter(0, interval * .1), finished + 60)
        with worker.store.engine.begin() as conn:
            same_request = checks.c.generation == row["generation"]
            conn.execute(update(checks).where(key).values(progress={}, started_at=None,
                last_success_at=checks.c.last_success_at if metadata_only else finished, runtime_due_at=next_due,
                error_code=None, failures=0, priority=case((same_request, False), else_=checks.c.priority),
                requested_at=case((same_request, None), else_=checks.c.requested_at),
                due_at=case((same_request, next_due), else_=finished + 60)))
    except Deferred as error:
        with worker.store.engine.begin() as conn:
            conn.execute(update(checks).where(key).values(due_at=max(now + 1, error.until)))
    except Superseded:
        pass
    except worker.application_errors as error:
        code = error.code if isinstance(error, (SourceFailure, worker.rejected_error)) else "invalid_application_data"
        failures = row["failures"] + 1
        delay = max(min(3600, 30 * 2 ** min(failures - 1, 7)), getattr(error, "retry_after", 0))
        with worker.store.engine.begin() as conn:
            conn.execute(update(checks).where(key).values(error_code=code, failures=failures,
                due_at=worker.clock() + delay + worker.jitter(0, 10), progress={}, started_at=None))
        worker.mark_application_error(source, app, code)
        if worker.origin_failure(code):
            worker.fail_source(getattr(error, "source", None) or source, error)
    return True


def stats(store, now):
    pending = (checks.c.last_success_at.is_(None) | (checks.c.due_at <= now) |
               checks.c.started_at.is_not(None) | checks.c.priority)
    pending_since = func.least(func.coalesce(checks.c.started_at, checks.c.due_at),
        case((checks.c.runtime_due_at <= now, checks.c.runtime_due_at), else_=checks.c.due_at),
        func.coalesce(checks.c.requested_at, checks.c.due_at))
    with store.engine.connect() as conn:
        return {row["source"]: dict(row) for row in conn.execute(select(checks.c.source,
            func.count().label("tracked_applications"),
            func.count().filter(pending).label("pending_applications"),
            func.count().filter(checks.c.error_code.is_not(None)).label("application_error_count"),
            func.array_agg(checks.c.name).filter(checks.c.error_code.is_not(None)).label("error_names"),
            func.json_agg(func.json_build_object("application", checks.c.name, "code", checks.c.error_code))
                .filter(checks.c.error_code.is_not(None)).label("error_details"),
            func.min(pending_since).filter(pending).label("oldest_pending_at"),
            func.max(checks.c.last_success_at).label("last_application_success_at")).group_by(checks.c.source)).mappings()}
