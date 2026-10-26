from contextlib import asynccontextmanager
import hmac
import logging
import threading
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy import select

from .config import load_settings, secret
from .contracts import ENVIRONMENTS, DeliveryEvent
from .reconcile import Reconciler
from .store import Rejected, Store, services
from .auth import BrowserAuth, add_routes
from .ci_identity import CIJob, authenticate as ci_authenticate, policy as ci_policy, refresh_registry
from .argo_notifications import ArgoNotification, ingest as ingest_notification
from .application_queue import stats as application_stats, resource_interval

log = logging.getLogger("sdm")


class BodyLimit:
    def __init__(self, app, limit):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.limit:
                return await JSONResponse({"error": "payload_too_large"}, status_code=413)(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        sent = False
        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def create_app(settings=None, store=None, reconciler=None, browser_auth=None):
    settings = settings or load_settings()
    store = store or Store(settings.database_url)
    reconciler = reconciler or Reconciler(store, settings)
    browser_auth = browser_auth or BrowserAuth(settings.oidc, store)
    stop = threading.Event()

    def background():
        while not stop.is_set():
            worked = False
            try:
                worked = reconciler.tick()
            except SQLAlchemyError:
                log.warning("reconcile database unavailable")
            except Exception:
                # Never emit raw upstream bodies, credentials or full exception strings.
                log.error("unexpected reconcile failure")
            # Metadata-only work must not cost a second per Application. HTTP is
            # still serialized by the worker lease and each source's persisted gate.
            stop.wait(.05 if worked else 1)

    @asynccontextmanager
    async def lifespan(app):
        if not store.ready():
            raise RuntimeError("database migration is required")
        thread = None
        if settings.reconcile_enabled:
            reconciler.bootstrap()
            thread = threading.Thread(target=background, name="reconciler", daemon=True)
            thread.start()
        yield
        stop.set()
        if thread:
            thread.join(timeout=35)
        reconciler.client.close()
        browser_auth.client.close()
        store.engine.dispose()

    app = FastAPI(title="Service Delivery Monitor", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimit, limit=settings.request_body_bytes)
    add_routes(app, browser_auth)

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/api/", "/auth/")):
            response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid(request, error):
        return JSONResponse({"error": "invalid_event", "details": [
            {"location": item["loc"], "type": item["type"]} for item in error.errors()]}, status_code=422)

    @app.exception_handler(Rejected)
    async def rejected(request, error):
        return JSONResponse({"error": error.code}, status_code=error.status)

    @app.exception_handler(IntegrityError)
    async def conflict(request, error):
        return JSONResponse({"error": "concurrent_event_conflict", "retryable": True}, status_code=409)

    @app.exception_handler(SQLAlchemyError)
    async def unavailable(request, error):
        return JSONResponse({"error": "storage_unavailable", "retryable": True}, status_code=503)

    def bearer(authorization, env):
        expected = secret(env, 32)
        if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(authorization[7:].encode(), expected.encode()):
            raise HTTPException(401, "invalid_credentials", headers={"WWW-Authenticate": "Bearer"})

    def reader(request: Request, authorization: str | None = Header(default=None)):
        if not authorization and browser_auth.identity(request):
            return
        bearer(authorization, settings.reader_token_env)

    def producer(request: Request, x_producer_id: str = Header(), authorization: str | None = Header(default=None)):
        if request.url.path == "/api/v1/ci/events" and x_producer_id != "gitlab-ci":
            raise HTTPException(401, "ci_identity_required")
        if x_producer_id == "gitlab-ci":
            if not authorization or not authorization.startswith("Bearer "):
                raise HTTPException(401, "invalid_ci_identity")
            return x_producer_id, ci_authenticate(authorization[7:], settings.ci_identity, store)
        config = settings.producers.get(x_producer_id)
        if config is None:
            raise HTTPException(401, "invalid_credentials")
        bearer(authorization, config.token_env)
        return x_producer_id, config

    def argo_sender(x_argo_source: str = Header(), authorization: str | None = Header(default=None)):
        config = settings.integrations.get(x_argo_source)
        if not config or config.kind != "argocd" or not config.notification_token_env:
            raise HTTPException(401, "invalid_credentials")
        bearer(authorization, config.notification_token_env)
        return x_argo_source, config

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/readyz")
    def ready():
        return {"status": "ready"} if store.ready() else JSONResponse({"status": "not_ready"}, 503)

    @app.post("/api/v1/ci/events", status_code=202)
    @app.post("/api/v1/events", status_code=202)
    def receive_event(event: DeliveryEvent, identity=Depends(producer)):
        if isinstance(identity[1], CIJob):
            identity = ci_policy(event, identity[1], settings.ci_identity, store)
        if event.occurred_at.timestamp() > time.time() + settings.event_clock_skew_seconds:
            raise Rejected("event_time_in_future", 422)
        if event.runtime and event.runtime.application_created_at > event.occurred_at:
            raise Rejected("application_created_after_event", 422)
        try:
            return store.ingest(event, *identity, settings.integrations)
        except Rejected as error:
            if (settings.ci_identity and identity[0].startswith("gitlab-ci:publisher:")
                    and error.code == "service_not_registered"):
                with store.engine.connect() as conn:
                    if conn.execute(select(services.c.key).where(services.c.key == event.service)).first():
                        raise
                refresh_registry(settings.ci_identity, store)
                raise HTTPException(503, "registry_not_ready", headers={"Retry-After": "60"}) from None
            raise

    @app.get("/api/v1/services", dependencies=[Depends(reader)])
    def catalog():
        items = store.catalog_state()
        inventory = store.environment_inventory([name for name, config in settings.integrations.items() if config.kind == "gitlab"])
        present = [instance for service in items for instance in service["instances"]
                   if instance.get("present") is True and not instance["lifecycle"].get("stopped_at")]
        # Existing observations cover the first inventory collection after an upgrade.
        available = set(inventory) if inventory is not None else {
            instance["environment"] for instance in present if instance["environment"] != "feature"}
        available.discard("feature")
        if any(instance["environment"] == "feature" for instance in present):
            available.add("feature")
        return {"items": items, "environments": [name for name in ENVIRONMENTS if name in available], "links": {
            "gitlab": next((c.base_url for c in settings.integrations.values() if c.kind == "gitlab"), None),
            "argo": {name: c.base_url for name, c in settings.integrations.items() if c.kind == "argocd"},
            "argo_check_intervals": {name: c.interval_seconds for name, c in settings.integrations.items() if c.kind == "argocd"},
            "deployments": next((c.deployment_repo_url for c in settings.integrations.values() if c.kind == "argocd"), None),
            "vault_stores": settings.vault_stores,
        }}

    @app.post("/api/v1/argocd/events", status_code=202)
    def receive_notification(event: ArgoNotification, identity=Depends(argo_sender)):
        return ingest_notification(store, event, *identity, clock_skew=settings.event_clock_skew_seconds)

    @app.get("/api/v1/services/{key}", dependencies=[Depends(reader)])
    def state(key: str):
        return store.service_state(key)

    @app.get("/api/v1/services/{key}/events", dependencies=[Depends(reader)])
    def history(key: str, before: int | None = Query(default=None, gt=0), limit: int = Query(default=50, ge=1, le=100),
                instance: str | None = Query(default=None, max_length=200)):
        state = store.service_state(key)
        target = next((item for item in state["instances"] if item["id"] == instance), None)
        if instance is not None and target is None:
            raise HTTPException(404, "instance_not_found")
        return {"items": store.event_history(key, before, limit, instance_id=instance,
                                            source_ref=target["source_ref"] if target else None)}

    @app.get("/api/v1/sources", dependencies=[Depends(reader)])
    def source_status():
        # Explicit metadata only: no continuation state, integration credentials or URLs.
        fields = ("name", "last_success_at", "last_attempt_at", "error_code", "failures",
                  "next_request_at", "window_start", "window_count", "backoff_until")
        limits = ("interval_seconds", "requests_per_window", "window_seconds",
                  "min_request_interval_seconds", "timeout_seconds")
        items = []
        queued = application_stats(store, time.time())
        for row in store.source_status():
            config = settings.integrations.get(row["name"])
            if config is None and row["name"] != "registry":
                continue
            queue = queued.get(row["name"], {})
            errors = set(row["state"].get("application_errors", {})) | set(queue.get("error_names") or [])
            code = row["error_code"] or ("partial_application_failure" if errors else None)
            details = {name: {"application": name, "code": failure}
                       for name, failure in row["state"].get("application_errors", {}).items()}
            details.update({item["application"]: item for item in queue.get("error_details") or []})
            last_error = row["state"].get("last_application_error") or {}
            items.append({**{key: row[key] for key in fields}, "error_code": code,
                          "kind": config.kind if config else "bootstrap",
                          "application_error_count": len(errors),
                          "application_errors": [details[key] for key in sorted(details)[:100]],
                          "last_application_error": {key: last_error.get(key) for key in ("application", "code", "checked_at")} if last_error else None,
                          **{key: queue.get(key) for key in ("tracked_applications", "pending_applications", "oldest_pending_at", "last_application_success_at")},
                          "resource_interval_seconds": resource_interval(config, row["state"].get("count", 0)) if config and config.kind == "argocd" else None,
                          **{key: getattr(config, key, None) for key in limits}})
        return {"items": items}

    @app.get("/api/v1/events", dependencies=[Depends(reader)])
    def all_history(before: int | None = Query(default=None, gt=0), limit: int = Query(default=50, ge=1, le=100)):
        return {"items": store.event_history(None, before, limit)}

    @app.get("/api/v1/schema/event", dependencies=[Depends(reader)])
    def event_schema():
        return DeliveryEvent.model_json_schema()

    @app.get("/api/v1/schema/argocd-notification", dependencies=[Depends(reader)])
    def notification_schema():
        return ArgoNotification.model_json_schema()

    if settings.frontend_dir and Path(settings.frontend_dir).is_dir():
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
    return app
