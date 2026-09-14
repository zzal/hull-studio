# Milestone 2: queue, worker, and a second environment

The application grows a decoupled queue and a background worker, and the
same blueprint deploys to two environments with different sizing. Still
AWS only, still the todos example, still cheap to test.

## Goal

Prove the two things milestone 1 deliberately left out: a link that is not
"read-write to a database" (produce and consume on a queue, with a tier on
each side), and an environment other than `dev` deployed from the same
blueprint. Along the way, the studio becomes a real editor: intents and
links are added and removed from the dashboard, and per-environment
overrides are edited there.

The demo script this milestone must make true, on a clean account, twice
in a row:

```bash
hull init                     # the two intents and a link, as before
hull studio                   # add a queue and a worker from the dashboard,
                              # link api -> queue (produce), worker -> queue
                              # (consume), worker -> db (read-write)
hull deploy --env dev
curl -X POST https://<api>/todos -d '{"title":"Ship milestone 2"}'   # the API enqueues
curl https://<api>/todos      # the worker has written the row to Postgres
hull deploy --env prod        # same blueprint, bigger sizing, its own state
hull destroy --env dev
hull destroy --env prod
```

## Blueprint additions

Additive to the v0 schema; every milestone 1 blueprint stays valid.

```yaml
usage:
  requestsPerMonth: 100000
  storageGb: 1
  messagesPerMonth: 100000    # new, optional, 0 when absent

intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
      - to: db
        role: read-write
      - to: jobs
        role: produce

  jobs:                       # new kind
    kind: queue
    resolution: sqs-standard

  worker:                     # new kind: a tier, like http-api
    kind: background-worker
    resolution: lambda-worker
    entry: src/worker/index.ts
    links:
      - to: jobs
        role: consume
      - to: db
        role: read-write

  db:
    kind: relational-database
    resolution: rds-postgres

environments:
  dev: {}
  prod:
    usage:
      requestsPerMonth: 2000000
      messagesPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
      worker:
        maxConcurrency: 10
```

Rules added to the validator:

- `queue` accepts the roles `produce` and `consume`; `relational-database`
  still accepts only `read-write`.
- A queue has at most one consuming tier. Competing consumers across tiers
  is a design the first-time user should not stumble into; a queue with no
  consumer yet is allowed, because the studio adds things one at a time.
- `background-worker` requires `entry` and may carry `links`, like
  `http-api`; a queue or a database carries none.
- A link may target only a `queue` or a `relational-database`; a tier never
  links to a tier in this milestone.

## Catalog v1

| Intent kind | Resolution | Deployable | Sizing parameters |
|---|---|---|---|
| `queue` | `sqs-standard` | yes | `visibilityTimeoutSeconds`, `retentionDays` |
| `background-worker` | `lambda-worker` | yes | `memoryMb`, `timeoutSeconds`, `batchSize`, `maxConcurrency` |
| `background-worker` | `fargate-worker` | no (cost model and rules only) | `cpu`, `memoryMb`, `desiredCount` |

Sizing derivation stays a pure function of the usage profile. The low-end
profile yields a 60 s visibility timeout and 4 days of retention for the
queue, and 512 MB / 30 s / batches of 10 / concurrency 2 for the worker.
Message volume bands mirror the request bands.

Cost models: the queue meters SQS requests (three per message: send,
receive, delete, with receives batched by the worker's batch size); the
worker meters Lambda invocations (messages over batch size) and duration.
The pricing refresh gains the SQS request SKU, and the free tier block
gains SQS's always-free one million requests a month, verified the same
way as the Lambda allowance.

Recommendation for `background-worker`: `lambda-worker` against
`fargate-worker` on cost at the profile, ops burden, scaling ceiling, and
a new dimension, job duration (Lambda stops at 15 minutes).

## Compiler and deploy

- A `queue` becomes an SQS standard queue plus a dead-letter queue (five
  receives, fourteen days of retention). Every queue gets the dead-letter
  queue; a poison message that blocks a worker forever is the failure a
  first-time user cannot diagnose.
- A `background-worker` becomes a Lambda from its bundled entry with an
  event source mapping from the consumed queue: batch size and maximum
  concurrency from the sizing, partial batch failures reported. A worker
  linked to a database is attached to the VPC like the API; one linked
  only to a queue stays outside it.
- Each link is one IAM statement set plus environment variables on the
  source tier: `produce` grants send on the queue; `consume` grants
  receive, delete and attribute reads (what the event source mapping
  needs on the role); `read-write` is unchanged from milestone 1.
- Env-var contract for a queue link: `HULL_<INTENT>_URL` and
  `HULL_<INTENT>_ARN`.
- Bindings: a `produce` link exports `jobs.send(message)`, which JSON-encodes
  the message and sends it; a `consume` link exports `jobs.consume(handler)`,
  which turns an SQS batch into one handler call per decoded message and
  reports the ones that threw as batch item failures. The worker entry
  exports `handler = jobs.consume(async (message) => { ... })`.
- `hull deploy --env prod` and `--env dev` are two stacks on the same
  state bucket with the same passphrase; nothing in the CLI changes for
  this, and the ticket proves it.

## Studio v1

- Adding and removing intents and links from the dashboard: a palette of
  the four kinds, each added with its recommended resolution and a
  generated name; a link drawn between a tier node and a queue or
  database node, its role picked from what the target accepts; removing
  either through the patch route, refused with diagnostics when the result
  would be invalid.
- Per-environment overrides: every sizing value in the estimate panel is
  editable for the selected environment; an edit writes an override, shown
  as overridden, and a reset removes it and the now-empty `overrides`
  mapping with it.
- A recommendation card on the worker node, like the API's.
- The client stays a patch editor: it never touches the file.

## Example

`examples/todos` gains `POST /todos`, which sends `{ title }` to the queue
and answers 202, and `src/worker/index.ts`, which inserts each message's
title into Postgres. `GET /todos` is unchanged, and now shows what the
worker wrote.

## Phases

### Phase 0: spike, throwaway

Network reach of a VPC-attached Lambda without a NAT gateway. Milestone 1
attaches the API to the default VPC for the database and its real run
passed, so its Secrets Manager call found a path; the worker adds SQS on
the same path, and the API's produce call too. Measure, from a VPC-attached
Lambda in a fresh default VPC: Secrets Manager and SQS calls with no
endpoint; then with an interface endpoint per service (about USD 7 a month
each per availability zone). Record the verdict in an ADR: either "no
endpoints needed" or "one interface endpoint per linked provider service,
counted in the estimate".

Exit: the ADR is written and the estimate knows the answer.

### Phase 1: blueprint and catalog

- The two kinds, the roles, `messagesPerMonth`, the validation rules, the
  schema snapshot.
- The three resolutions, sizing, cost models, SQS in the pricing refresh
  and the free tier block, the worker recommendation.

Exit: the estimate route prices the demo blueprint for `dev` and `prod`.

### Phase 2: studio

- Add and remove intents and links.
- Edit overrides per environment.
- Worker recommendation card.

Exit: the demo blueprint can be built from `hull init` in the dashboard
alone, and the file diff is exactly the added intents and links.

### Phase 3: compiler, bindings, deploy

- Queue, dead-letter queue, worker, event source mapping, IAM per link,
  under the mock runtime.
- Queue bindings on both sides; the example's worker.
- `dev` and `prod` side by side; the demo script twice; the README.

Exit: the full demo script runs twice in a row on a clean account.

## Test budget

A demo run with both environments up for an hour, then destroyed:

| Line | Cost |
|---|---|
| Two RDS instances (`db.t4g.micro` in dev, `db.t4g.small` in prod) | about USD 0.05 an hour together |
| SQS, Lambda, API Gateway at demo traffic | always-free allowances |
| Interface endpoints, if the spike says they are needed | about USD 0.01 an hour each |
| S3 state bucket | cents |

Never leave either environment up overnight.

## Risks

- **VPC Lambda reach without NAT.** The spike settles it before the
  compiler ticket starts. If endpoints are needed, they change the estimate
  and the "no NAT gateway" story needs a sentence about them.
- **Partial batch failures.** An SQS batch where one message throws must
  not redeliver the nine that succeeded. The consume binding reports item
  failures, and the mock-runtime test asserts the event source mapping asks
  for them.
- **Studio edits that pass through an invalid state.** Adding a link in two
  steps (pick target, pick role) must be one patch, or the file is refused
  midway.

## Out of scope for this milestone

Scheduled job, storage, user directory, secrets, web frontend, the
disaster recovery policy, `hull eject`, `hull dev`, raw-resource escape
hatch, GCP, hosted studio, IDE extension, observed-usage costs, FIFO
queues, fan-out (one message to many consumers), tier-to-tier links, KMS
secrets provider, publishing the schema at a public URL.
