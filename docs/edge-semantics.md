# Relationship semantics

Color supports the graph's grouping and selection; labels and line style retain relationship meaning without relying on color alone.

- Sources/control inputs use muted shared UI tokens.
- Artifacts, Kubernetes and Secrets use their resource-kind presentation.
- The selected path uses amber with light/dark adaptation.
- Inactive paths remain readable and subdued.

A shared route is a visual bus, not a new dependency. The inspector retains individual direct relations. Selected resources highlight only their supported path and branch segments. Unrelated image/config inputs must not be highlighted merely because they share an Argo or chart context.

Source evidence remains visible in resource details. Short directional motion appears only for selection and is disabled by reduced-motion preference. The graph keeps the current viewport unless the user explicitly changes it.
