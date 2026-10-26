"""Only resource references and filenames, never environment/config/secret values."""


def workload_metadata(values):
    result = []
    for section, kind in [("deployments", "Deployment"), ("jobs", "Job")]:
        for key, workload in (values.get(section) or {}).items():
            config, eso = workload.get("config") or {}, workload.get("externalSecret") or {}
            refs = []
            for entry in workload.get("envFrom") or []:
                for field, resource_kind in [("secretRef", "Secret"), ("configMapRef", "ConfigMap")]:
                    if entry.get(field, {}).get("name"):
                        refs.append({"kind": resource_kind, "name": entry[field]["name"], "relation": "envFrom"})
            for entry in workload.get("env") or []:
                for field, resource_kind in [("secretKeyRef", "Secret"), ("configMapKeyRef", "ConfigMap")]:
                    ref = (entry.get("valueFrom") or {}).get(field) or {}
                    if ref.get("name"):
                        refs.append({"kind": resource_kind, "name": ref["name"], "relation": "env"})
            for entry in workload.get("volumes") or []:
                for field, name_field, resource_kind in [("secret", "secretName", "Secret"), ("configMap", "name", "ConfigMap")]:
                    ref = entry.get(field) or {}
                    if ref.get(name_field):
                        refs.append({"kind": resource_kind, "name": ref[name_field], "relation": "mount"})
            remote = []
            if eso.get("enabled"):
                for entry in eso.get("data") or []:
                    ref = entry.get("remoteRef") or {}
                    if ref.get("key"):
                        remote.append({**{k: ref[k] for k in ["key", "property"] if k in ref},
                                       "mode": "property" if ref.get("property") else "value"})
                for entry in eso.get("dataFrom") or []:
                    ref = entry.get("extract") or {}
                    if ref.get("key"):
                        remote.append({"key": ref["key"], "mode": "extract"})
            result.append({"key": key, "kind": kind, "name": workload.get("name"),
                "image": {k: workload["image"][k] for k in ["repository", "digest"] if k in workload.get("image", {})}
                    if workload.get("image") else None,
                "desired_replicas": workload.get("replicaCount"), "config_files": list((config.get("files") or {}).keys()),
                "config_mounts": [{k: m[k] for k in ["mountPath", "subPath"] if k in m} for m in config.get("mounts") or []],
                "config_mount_path": config.get("mountPath"), "references": refs,
                "external_secret": {"enabled": bool(eso.get("enabled")), "env_from": eso.get("envFrom", True),
                    "store": {k: (eso.get("secretStoreRef") or {})[k] for k in ["name", "kind"] if k in (eso.get("secretStoreRef") or {})},
                    "remote_refs": remote}})
    return result
