# Service Delivery Monitor

## Purpose

Help an operator trace service provenance and distinguish requested delivery from observed runtime. The product is a desktop operational interface, not a deployment controller.

## Views

The catalog finds services and environment instances. Overview separates source, build, publication, Argo and runtime. The map explains resources and direct relationships with evidence. History preserves job attempts, events, failure and recovery. Sources reports collection health and budget.

## Guarantees and limits

Unknown data remains unknown. Stale data keeps its observation time. A failed new attempt does not erase a previous confirmed deployment. A build or release tag does not establish rollout success. Browser reads never trigger upstream collection.

GitLab and Argo CD are the supported external collectors. The publisher allowlist/generated-values contract must match the configured source. GitHub hosting does not add a GitHub Actions delivery integration. Browser access uses OIDC; local password login and team-level RBAC are not implemented.

The backend does not deploy, sync Argo or read Kubernetes directly. Business-level health remains outside the generic runtime evidence shown here.
