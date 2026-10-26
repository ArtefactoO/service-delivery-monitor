# Deploy SDM

Build the runtime image from the included Dockerfile:

```sh
docker build --target runtime -f deploy/Dockerfile -t sdm:local .
```

Run `python -m sdm init-db` to initialize the PostgreSQL schema, then `python -m sdm serve` for the application. The local Compose command `local` performs local initialization and creates temporary machine tokens. It does not configure browser login.

Provide `DATABASE_URL` using the `postgresql+psycopg://` driver URL and `SDM_CONFIG` pointing to a non-secret JSON configuration file. Supply each credential through its configured environment variable or `_FILE` path. Runtime runs as UID/GID 10001 with a read-only filesystem and writable temporary paths.

For shared use, provide durable PostgreSQL, backups, HTTPS, configured OIDC and read-only source identities. Check `/healthz` and `/readyz` separately from an authenticated catalog read. Initialize or migrate state before admitting traffic.

The repository includes Compose and portable container builds. It does not bundle an environment-specific Helm chart, Argo Application, ingress class, DNS record or secret-store policy. The GitHub workflow does not publish images or sync a cluster.

Deploy your own notification controller/configuration if using Argo Notifications. Signals enter the existing collection budget and do not bypass verification. See [access](access.md), [catalog source](catalog-source.md) and [event contract](events.md).
