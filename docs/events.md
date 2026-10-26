# Event contract v1

`POST /api/v1/events` accepts normalized JSON, up to the configured body limit (256 KiB by default). Unknown fields are rejected. The machine-readable contract is [event.schema.json](event.schema.json).

```http
Content-Type: application/json
X-Producer-ID: publisher
Authorization: Bearer <scoped-token>
```

The producer ID selects a server-side policy. Payload fields do not grant permissions. Admission checks event kind, source project, attempt project, environment and the service/project registry binding.

## Fields

| Field | Meaning |
| --- | --- |
| `schema_version` | `1` |
| `event_id` | UUID retained when retrying the same event |
| `kind` | `build`, `publication`, `deployment`, `argocd` |
| `status` | `started`, `succeeded`, `failed`, `canceled` |
| `action` | `upsert`, or `delete` for supported feature removal |
| `service` | Admitted catalog key |
| `source` | Service project ID, full ref and exact source SHA |
| `attempt` | Issuing project ID, pipeline ID, job ID and ordered sequence |
| `occurred_at` | Event time with timezone |
| `target` | Environment and instance, absent for build events |
| `publication` | Immutable values/chart/build/image provenance |
| `runtime` | Application identity and verification evidence |
| `images` | Build result images, only for build events |
| `build_revision` | Original image build commit, separate from the current result job |
| `absence_confirmed` | Supported successful feature stop without a known Application UID |
| `failure_code` | Short code required for failed/canceled outcomes |

Sequence is ordered within one job. Pipeline/job IDs are comparable only within the same issuing project. A retry job has a new job ID. A repeated ordered transition cannot be rewritten with a different payload. Older events remain in history with `applied=false` when they cannot update current state.

Failure codes match `[a-z][a-z0-9_.-]{0,79}`. Do not send error bodies, stdout, configuration, environment values or credentials.

## Meaning of success

- `build.succeeded`: the image or complete image set has been published and its digests are known. A build belongs to a service/ref and does not create a runtime instance.
- `publication.succeeded`: generated values were committed successfully. Include publication revision, values path/revision, build revision, image set, chart ref and config revision when present.
- `deployment.succeeded`: the existing rollout verifier confirmed the selected publication. Include publication and runtime identity with its verification time.
- `argocd`: an admitted Application signal schedules bounded reconciliation. It does not establish workload readiness by itself.

A failed publication before Git push leaves desired state unchanged. Failure after push can leave a confirmed publication and a failed deployment verification. Config-only publication retains the existing build revision and image digests. Generic pipeline success is not deployment success.

The GitLab CI identity endpoint is `/api/v1/ci/events` and has a separate admission policy. It does not accept browser sessions or a generic GitHub Actions OIDC token. A native GitLab webhook body is not automatically a normalized event. See [access](access.md).

## Feature identity and presence

Permanent targets use the supported environment/instance contract. Current feature names combine `ft-`, the normalized full ref suffix and service name within the supported length. Producers must share the backend's identity algorithm. Existing legacy identities are accepted only under the implemented exact validation rules, not an arbitrary name supplied by a caller.

A confirmed feature identity cannot be rebound to another service, project or full ref, including after stop. Started/failed/canceled events without confirmed publication/runtime evidence remain historical and do not reserve an instance name.

Presence, Application UID, creation time and runtime observation time are separate evidence. An older absence cannot stop a more recently confirmed live instance. A new UID is a new lifetime. Deletion does not erase the event history.

## Delivery and persistence

`202` is returned after the event is committed to PostgreSQL. Keep event IDs and payloads stable for retries. A source job's telemetry transport should have a bounded timeout and should not redefine whether its primary build/deploy operation succeeded.

Argo Notifications have a separate [schema](argocd-notification.schema.json) and token. They debounce work in the existing queue and budget. They do not bypass source scope, create an arbitrary runtime instance or prove a healthy rollout.
