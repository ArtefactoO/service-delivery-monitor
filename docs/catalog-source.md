# Catalog source contract

## Local registry

`backend/config/registry.example.json` declares a synthetic service with key, source project ID/path and test ref. `backend/config/local.json` uses this file with external integrations disabled.

## Publisher-backed collector

The current GitLab collector reads a literal `SERVICES` allowlist from the configured publisher project/ref/path. The default path is `ci/publish.py`. The mapping key becomes the catalog service key. Source project metadata and environment identity must agree with the generated deployment values.

Configure `integrations` entries of kind `gitlab` with a fixed HTTPS `base_url`, `token_env`, publisher `project_id`, `ref` and `registry_path`. Supply an appropriately scoped read-only account that can also read the admitted source projects. Source-version collection needs access to source CI includes and release tags, not just the publisher project.

Argo integrations declare fixed HTTPS origins, allowed projects/environments and the matching `deployment_repo_url`. Runtime collection is explicitly enabled through its supported settings. Keep one budget per configured origin.

Generated values supply supported source/build/config/image provenance and workload references. Annotation keys use `delivery.example.com/` in this public edition. Producers and collector must agree on that namespace and schema.

This is a specific publisher contract, not generic auto-discovery for every GitOps layout. Adapt an integration explicitly and add contract tests if your publisher differs. Hosting SDM source on GitHub does not change its GitLab delivery collector.
