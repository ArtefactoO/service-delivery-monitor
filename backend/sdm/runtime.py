"""Bounded resource reads, linked by UID. No manifests or environment values persist."""
import json
import re
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import UUID

from .store import iso

GROUPS = {"Pod": "", "Deployment": "apps", "StatefulSet": "apps", "DaemonSet": "apps", "Job": "batch",
          "Service": "", "Ingress": "networking.k8s.io"}
PROJECTION_VERSION = 6
NAME = re.compile(r"[a-z0-9][a-z0-9.-]{0,252}")
KIND = re.compile(r"[A-Za-z][A-Za-z0-9]{0,62}")
REASON = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,127}")


def conditions(items):
    return [{"type": item.get("type"), "status": item.get("status"),
             **({"reason": item["reason"]} if isinstance(item.get("reason"), str) and REASON.fullmatch(item["reason"]) else {})}
            for item in items or []]


def container_state(value):
    name = next((key for key in ("waiting", "terminated", "running") if key in value), None)
    state = value.get(name) or {}
    return {**({"state": name} if name else {}),
            **({"reason": state["reason"]} if isinstance(state.get("reason"), str) and REASON.fullmatch(state["reason"]) else {}),
            **({"exit_code": state["exitCode"]} if isinstance(state.get("exitCode"), int) else {})}


def last_termination(value):
    state = value.get("terminated") if isinstance(value, dict) else None
    if not isinstance(state, dict):
        return {}
    result = {**({"reason": state["reason"]} if isinstance(state.get("reason"), str) and REASON.fullmatch(state["reason"]) else {}),
              **({"exit_code": state["exitCode"]} if type(state.get("exitCode")) is int else {})}
    finished = state.get("finishedAt")
    if isinstance(finished, str) and len(finished) <= 64:
        try:
            parsed = datetime.fromisoformat(finished)
            if parsed.tzinfo is not None:
                result["finished_at"] = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError):
            pass
    return {"last_termination": result} if result else {}


def uid(value):
    if not isinstance(value, str):
        raise ValueError("runtime UID is missing")
    return str(UUID(value))


def refs(items):
    result = []
    for item in items or []:
        kind, name = item.get("kind"), item.get("name")
        if item.get("uid") and isinstance(kind, str) and KIND.fullmatch(kind) and isinstance(name, str) and NAME.fullmatch(name):
            group = item.get("group")
            version = item.get("apiVersion")
            if group is None and isinstance(version, str):
                group = version.rsplit("/", 1)[0] if "/" in version else ""
            safe_group = isinstance(group, str) and (group == "" or len(group) <= 253 and NAME.fullmatch(group))
            result.append({"uid": uid(item["uid"]), "kind": kind, "name": name,
                           **({"group": group} if safe_group else {}),
                           **({"controller": item["controller"]} if "controller" in item else {})})
    return result


def labels(value):
    if (not isinstance(value, dict) or len(value) > 128 or
            any(not isinstance(k, str) or not isinstance(v, str) or len(k) > 320 or len(v) > 63 for k, v in value.items())):
        return {}
    return value


def tls_host(host, pattern):
    return host == pattern or (pattern.startswith("*.") and host.endswith(pattern[1:])
        and "." not in host[:-len(pattern[1:])])


def project_manifest(obj, node, observed_at):
    meta, spec, status = obj.get("metadata") or {}, obj.get("spec") or {}, obj.get("status") or {}
    if (obj.get("kind") != node["kind"] or meta.get("name") != node["name"]
            or meta.get("namespace") != node["namespace"] or uid(meta.get("uid")) != node["uid"]):
        raise ValueError("runtime resource identity changed")
    result = {**{k: node[k] for k in ["uid", "kind", "name", "namespace", "group"]},
              "resourceVersion": str(meta.get("resourceVersion", "")), "fetched_at": observed_at, "checked_at": observed_at,
              "owner_refs": refs(meta.get("ownerReferences")), "deleting": bool(meta.get("deletionTimestamp"))}
    if node["kind"] == "Pod":
        references = []
        def reference(kind, name, relation):
            if isinstance(name, str) and NAME.fullmatch(name):
                item = {"kind": kind, "name": name, "relation": relation}
                if item not in references:references.append(item)
        for secret in spec.get("imagePullSecrets") or []:
            reference("Secret", secret.get("name"), "image pull secret")
        for container in (spec.get("containers") or []) + (spec.get("initContainers") or []):
            for value in container.get("envFrom") or []:
                reference("Secret", (value.get("secretRef") or {}).get("name"), "envFrom")
                reference("ConfigMap", (value.get("configMapRef") or {}).get("name"), "envFrom")
            for value in container.get("env") or []:
                source = value.get("valueFrom") or {}
                reference("Secret", (source.get("secretKeyRef") or {}).get("name"), "env")
                reference("ConfigMap", (source.get("configMapKeyRef") or {}).get("name"), "env")
        for volume in spec.get("volumes") or []:
            reference("Secret", (volume.get("secret") or {}).get("secretName"), "mount")
            reference("ConfigMap", (volume.get("configMap") or {}).get("name"), "mount")
            reference("PersistentVolumeClaim", (volume.get("persistentVolumeClaim") or {}).get("claimName"), "mount")
            for source in (volume.get("projected") or {}).get("sources") or []:
                reference("Secret", (source.get("secret") or {}).get("name"), "projected mount")
                reference("ConfigMap", (source.get("configMap") or {}).get("name"), "projected mount")
        containers = []
        for field, initial in [("containerStatuses", False), ("initContainerStatuses", True)]:
            for container in status.get(field) or []:
                containers.append({"name": container["name"], "image": container.get("image"),
                    "image_id": container.get("imageID"), "ready": bool(container.get("ready")),
                    "restarts": max(0, int(container.get("restartCount", 0))), "init": initial,
                    **container_state(container.get("state") or {}),
                    **last_termination(container.get("lastState"))})
        account = spec.get("serviceAccountName")
        if isinstance(account, str) and NAME.fullmatch(account):
            reference("ServiceAccount", account, "service account")
        result.update(phase=status.get("phase", "Unknown"), conditions=conditions(status.get("conditions")),
                      containers=containers, references=references,
                      pod_labels=labels(meta.get("labels")), service_account=account,
                      images=[{"name": c["name"], "image": c.get("image")} for c in spec.get("containers") or []]
                          + [{"name": c["name"], "image": c.get("image"), "init": True} for c in spec.get("initContainers") or []])
    elif node["kind"] == "Service":
        result.update(selector=labels(spec.get("selector")), service_type=spec.get("type"))
    elif node["kind"] == "Ingress":
        routes = []
        for rule in spec.get("rules") or []:
            host = rule.get("host", "")
            if not isinstance(host, str):
                continue
            secure = any(not item.get("hosts") or any(tls_host(host, value) for value in item["hosts"])
                         for item in spec.get("tls") or [])
            for route in (rule.get("http") or {}).get("paths") or []:
                backend = (route.get("backend") or {}).get("service") or {}
                routes.append({"host": host, "path": route.get("path", "/"),
                    "path_type": route.get("pathType", "ImplementationSpecific"), "tls": secure,
                    "service_name": backend.get("name")})
        default_service = ((spec.get("defaultBackend") or {}).get("service") or {}).get("name")
        result.update(routes=routes, ingress_class=spec.get("ingressClassName"),
                      tls_secrets=sorted({item["secretName"] for item in spec.get("tls") or []
                          if isinstance(item.get("secretName"), str) and NAME.fullmatch(item["secretName"])}),
                      **({"default_backend_service": default_service}
                         if isinstance(default_service, str) and NAME.fullmatch(default_service) else {}))
    else:
        fields = ["replicas", "readyReplicas", "availableReplicas", "updatedReplicas", "currentReplicas",
                  "numberReady", "desiredNumberScheduled", "currentNumberScheduled", "numberAvailable", "updatedNumberScheduled",
                  "active", "succeeded", "failed", "observedGeneration"]
        template = spec.get("template") or {}
        result.update(desired_replicas=spec.get("replicas"), generation=meta.get("generation"),
                      pod_labels=labels((template.get("metadata") or {}).get("labels")),
                      service_account=(template.get("spec") or {}).get("serviceAccountName"),
                      status={**{k: status[k] for k in fields if k in status},
                              "conditions": conditions(status.get("conditions"))})
    return result


def collect_runtime(name, app, cached, get, checkpoint, clock, maximum):
    progress = app.get("_runtime")
    if progress and progress.get("projection_version") != PROJECTION_VERSION:
        app.pop("_runtime", None)
        progress = None
        checkpoint()
    if progress is None:
        body, _ = get(name, f"/api/v1/applications/{quote(app['name'], safe='')}/resource-tree",
                      params={"project": app["project"]})
        nodes = json.loads(body).get("nodes")
        if not isinstance(nodes, list):
            raise ValueError("invalid runtime tree")
        tree = []
        for node in nodes[:5000]:
            if node.get("namespace") != app["namespace"] or not KIND.fullmatch(node.get("kind", "")):
                continue
            if not node.get("uid") or not NAME.fullmatch(node.get("name", "")):
                continue
            kind = node["kind"]
            if kind in GROUPS and node.get("group", "") != GROUPS[kind]:
                continue
            health = (node.get("health") or {}).get("status")
            tree.append({"uid": uid(node["uid"]), "name": node["name"], "namespace": app["namespace"],
                         "kind": kind, "group": node.get("group", ""), "version": node.get("version") or "v1",
                         "resourceVersion": str(node.get("resourceVersion", "")), "parent_refs": refs(node.get("parentRefs")),
                         **({"health": health} if isinstance(health, str) and len(health) <= 64 else {})})
        tracked = [n for n in tree if n["kind"] in GROUPS]
        old = {x["uid"]: x for x in cached.get("objects", [])} if (cached.get("application_uid") == app["uid"]
            and cached.get("projection_version") == PROJECTION_VERSION) else {}
        progress = {"application_uid": app["uid"], "projection_version": PROJECTION_VERSION, "observed_at": iso(clock()), "tree": tree,
                    "objects": [], "pending": tracked[:maximum], "truncated": len(tracked) > maximum or len(nodes) > 5000}
        for node in list(progress["pending"]):
            prior = old.get(node["uid"])
            if prior and node["resourceVersion"] and prior.get("resourceVersion") == node["resourceVersion"]:
                progress["objects"].append({**prior, "checked_at": progress["observed_at"]})
                progress["pending"].remove(node)
        app["_runtime"] = progress
        checkpoint()
    while progress["pending"]:
        node = progress["pending"][0]
        # The kind/group allowlist is rechecked after loading a persisted continuation.
        if node["kind"] not in GROUPS or node["group"] != GROUPS[node["kind"]] or node["namespace"] != app["namespace"]:
            raise ValueError("invalid runtime continuation")
        body, _ = get(name, f"/api/v1/applications/{quote(app['name'], safe='')}/resource",
                      params={"project": app["project"], "namespace": node["namespace"], "resourceName": node["name"],
                              "group": node["group"], "kind": node["kind"], "version": node["version"]})
        obj = json.loads(json.loads(body)["manifest"])
        progress["objects"].append(project_manifest(obj, node, iso(clock())))
        progress["pending"].pop(0)
        checkpoint()
    return {k: v for k, v in progress.items() if k != "pending"}


def summary(runtime):
    if not runtime:
        return None
    objects = runtime.get("objects", [])
    deployments = [o for o in objects if o["kind"] in {"Deployment", "StatefulSet", "DaemonSet"}]
    ready = sum(int(o.get("status", {}).get("readyReplicas", o.get("status", {}).get("numberReady", 0))) for o in deployments)
    desired = sum(int(o.get("desired_replicas") or o.get("status", {}).get("desiredNumberScheduled", 0)) for o in deployments)
    pods = [o for o in objects if o["kind"] == "Pod"]
    return {"ready": ready, "desired": desired, "controllers": len(deployments), "pods": len(pods),
            "restarts": sum(c["restarts"] for p in pods for c in p.get("containers", [])),
            "observed_at": runtime["observed_at"], "truncated": runtime.get("truncated", False)}
