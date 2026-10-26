# Resource graph discovery

The graph combines admitted generated-values provenance with Argo Application resource trees and supported runtime object metadata. It does not contact Kubernetes directly.

Sources, image artifacts, chart/values control inputs, Kubernetes resources and external-secret references have distinct identities. Owner references and Pod UIDs establish workload relationships. Labels can support documented selector relationships but cannot substitute for arbitrary ownership proof.

Preserve image repository/digest identity, config source/revision and resource namespace/kind/name. An unknown or partial observation must not fabricate a dependency. Each relation carries its source/evidence where available.

Graph layout and route sharing are presentation behavior. A bus segment can carry multiple relations without merging those relations in the data model. Selection filters the highlighted path while retaining direct relations in the inspector.

The implementation lives in the frontend graph/data modules and backend resource projection. Regression tests cover identity, presence, late observations, relationship highlighting, routing and viewport behavior.
