# Catalog, resource map and history

## Catalog and overview

Choose a service, environment and instance. The overview separates source/build provenance, desired publication, Argo state and observed runtime. Readiness and restart counts come from resource observations. Unknown replicas or unconfirmed versions are not converted into a success label.

The catalog uses the configured publisher allowlist. Permanent environments come from the supported publisher layout; feature instances are associated with observed Applications. Archived instances retain their history after deletion.

## Resource map

The map groups Sources, Artifacts, Control, Kubernetes and Secrets. Resource cards show fields appropriate to their kind. The inspector shows the selected resource, direct relations and evidence before additional technical fields.

Search includes resource names and ingress addresses. Selection preserves the viewport and highlights the selected dependency path in amber. A dedicated action returns the viewport to the selection. Parallel relations may share a routed segment while remaining separate dependencies in the model and inspector. Reduced motion disables the selection animation.

Secret relationships preserve the Vault → ExternalSecret → Secret → consumer path. Shared Argo/chart/values context must not invent unrelated image or configuration dependencies. Pod/controller links use observed UIDs and owners, including old rollout and init images.

## History

History groups job stages into operations with source links, exact event times and known durations. A duration is shown only when the same attempt has both endpoints. Late events retain their original payload and receipt time. Routine healthy discovery can be collapsed without hiding failures and recovery.

Service history respects environment/instance scope. Activity covers the catalog. A branch/tag-specific history route keeps its scope through refresh. Older pages use a fixed snapshot until explicitly refreshed.

## Refresh and failure

The active browser polls the SDM API every 30 seconds and refreshes on focus/network recovery. API requests have bounded timeouts and do not trigger upstream collection. Initial failure shows a load error. Refresh failure retains the previous snapshot with an explanation. Unauthorized responses close the view.

Sources exposes collection budget, backoff and partial failures. Observation age remains separate from upstream Sync/Health. Resource-version caching and bounded collection can make an observation older than a new event; these facts must remain visible independently.
