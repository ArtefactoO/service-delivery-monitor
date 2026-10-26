# Authentication and machine identities

## Local stack

The local command generates reader, publisher and build tokens in container tmpfs. It does not create a local username/password or browser session. Read the local catalog from inside the app container with `python local-read.py`; the script reads the token without printing it.

## Browser access

Configure the `oidc` block with an HTTPS issuer and public origin, for example `https://auth.example.com/application/o/sdm/` and `https://sdm.example.com`. Supply the configured client ID and client secret environment variables. The callback is `/auth/callback`; register the exact HTTPS redirect URI with your provider.

OIDC uses authorization code and PKCE. Cookies contain opaque, revocable session IDs. A logged-in browser can view the catalog; team-level RBAC is not implemented in this version. Browser sessions cannot publish events or mutate GitLab, Argo or Kubernetes.

## Machine readers and producers

`reader_token_env` selects the machine reader secret. Producers have their own `token_env`, allowed event kinds, project scope, attempt project and environments. Use `Authorization: Bearer ...` and the configured `X-Producer-ID` for normalized events. Secrets can be supplied by environment or the corresponding `_FILE` path.

The `/api/v1/ci/events` endpoint validates GitLab CI identity against the configured fixed issuer, audience, publisher project/ref and origin budget. It does not accept a generic GitHub Actions OIDC token. Other CI systems can use the normalized bearer-token API under a scoped producer.

Argo Notifications use a separate token on the configured Argo integration. A notification is a scheduling signal and does not prove runtime readiness.

## Collectors

Use a read-only GitLab service identity with access to the admitted publisher and source projects. A publisher-only project token cannot read unrelated source repositories. Argo access is read-only and scoped to allowed projects and Applications. SDM does not need Kubernetes credentials.

Keep tokens and database credentials in your secret manager, outside Git and non-secret config. Rotate with overlapping validity only as required, confirm reads using the runtime identity, then revoke the old credential. Do not substitute an operator token as evidence that a limited runtime identity works.
