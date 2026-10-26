# Architecture

SDM records delivery evidence and presents it in a service catalog, resource map and history. It does not own deployment, Argo synchronization or target-cluster credentials.

## Components

The FastAPI backend admits scoped events, persists them in PostgreSQL, exposes authenticated reads and reconciles external observations. The React desktop frontend reads saved backend state. PostgreSQL is the durable state and work queue. Argo CD supplies Application/resource observations; GitLab supplies catalog and version provenance under the configured contract.

## Evidence model

Source, build, publication, Argo Sync/Health and runtime are separate observations. A newer failed attempt cannot erase a previous confirmed deployment. Unknown values remain unknown. Staleness adds observation age without changing an upstream Sync/Health status.

Events are idempotent and retained with their source and receipt time. Delayed delivery does not rewrite immutable payloads. Application presence and runtime freshness are tracked independently. A stale absence does not stop a newer confirmed instance. UID changes preserve lifecycle identity.

## Collection

Browser polling reads PostgreSQL and never triggers upstream collection. Reconciliation uses per-source request budgets, minimum spacing, bounded timeouts, backoff and a persistent Application queue. Notifications debounce and schedule existing work rather than bypassing budget or proving rollout success.

Runtime comes through Argo resource metadata and object reads. It includes observed readiness, image IDs, restart counts and termination metadata, excluding application logs and messages. Unchanged resource versions reuse snapshots. Truncation and partial failure remain visible.

## Catalog contract

The collector expects a publisher allowlist and generated values with the documented provenance annotations. It does not automatically understand arbitrary GitOps repositories. The local registry example works without external collectors. See [catalog source](catalog-source.md).

## Authentication

Browser reads use an OIDC session over HTTPS. Machine readers and normalized producers use separate scoped bearer credentials. GitLab CI identity and Argo notification endpoints have their own admission contracts. A reader session cannot publish events or deploy anything. See [access](access.md).

## Frontend

The catalog, overview, resource map and history preserve environment/instance scope. The map shows documented relationships and their evidence. Selection highlights the selected path without changing the upstream model. Desktop is the supported device scope. See [user guide](user-guide.md), [graph discovery](graph-discovery.md) and [edge semantics](edge-semantics.md).
