# Milestone 2: queue, worker, and a second environment

The application grows a decoupled queue and a background worker, and the
same blueprint deploys to two environments with different sizing. Still
AWS only, still the todos example, still cheap to test.

## Goal

Prove the two things milestone 1 deliberately left out: a link that is not
"read-write to a database" (produce and consume on a queue, with a tier on
each side), and an environment other than `dev` deployed from the same
blueprint. And make the studio the primary surface it was always meant to
be: the first end-to-end run (2026-09-15) found a dashboard where
selecting a node does nothing, two numbers and one dropdown are the whole
editable surface, `hull init` is a step the studio could absorb, and
deploying is a separate terminal ritual with no plan to review before
costs start. This milestone fixes all four: a start screen, an inspector
on every node and edge, the resources each intent implies with their
estimate lines, adding and removing intents and links, per-environment
overrides, and plan, deploy and destroy from the dashboard and the CLI
alike, with a plan and the monthly figure shown before anything is
created.

The demo script this milestone must make true, on a clean account, twice
in a row:

```bash
hull studio                   # empty folder: the start screen writes the
                              # API + database template; then add a queue and
                              # a worker, link api -> queue (produce),
                              # worker -> queue (consume), worker -> db
                              # (read-write); plan and deploy dev from the
                              # dashboard, or from the terminal:
hull plan --env dev           # what would be created, and the monthly figure
hull deploy --env dev         # shows the plan, asks, then deploys
curl -X POST https://<api>/todos -d '{"title":"Ship milestone 2"}'   # the API enqueues
curl https://<api>/todos      # the worker has written the row to Postgres
hull deploy --env prod        # same blueprint, bigger sizing, its own state
hull destroy --env dev
hull destroy --env prod
```

`hull init` survives for scripts (`hull init --template api-database`);
the dashboard path and the terminal path must both complete the demo.

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

Milestone 1's dashboard is a viewer with two editable numbers. This
milestone makes it the editor and the operator.

- **Start screen.** `hull studio` in a folder without a blueprint starts
  anyway and shows a start screen: a template (the API plus database that
  `hull init` writes, or a blank blueprint with a name, the provider, a
  region, no intents and a `dev` environment). Choosing one writes the
  file, in canonical form, with the `.gitignore` entries, through the
  server like every other change, and the dashboard loads. `hull init`
  stays as the scripted path with `--template`.
- **Inspector.** Selecting a node opens an inspector for that intent: its
  name (a rename retargets every link to it in one patch), its kind, its
  resolution as a dropdown of the kind's candidates with the
  recommendation's reasons inline, the entry path for a tier, its links
  with their roles and a remove action each, and its sizing for the
  selected environment, each value marked derived or overridden. Selecting
  an edge shows its role and a remove action. A header panel edits the
  blueprint's name and region. Field diagnostics show in place.
- **What this deploys.** The inspector lists the resources the resolution
  implies (an RDS instance, its storage, a security group, the managed
  master password secret) with each one's estimate line, low, expected and
  high, with and without free tier. The estimate is explained, not
  announced. The list is catalog data per resolution; the compiler's test
  checks it against what the program actually declares.
- **Adding and removing.** A palette of the four kinds; adding writes the
  intent with its recommended resolution, a generated name, and a
  placeholder entry for a tier. A link is drawn from a tier node to a
  queue or database node, its role picked from what the target accepts,
  as one patch. Removing an intent or a link goes through the patch route
  and is refused with diagnostics when the result would be invalid.
- **Overrides.** Every sizing value in the inspector is editable for the
  selected environment; an edit writes an override, shown as overridden
  beside the derived value, and a reset removes it and the now-empty
  mappings with it.
- **Operations.** Plan, deploy and destroy for the selected environment,
  from the dashboard, with live progress. See the next section.
- The client remains a patch editor over the server: it never touches
  the file and never sees Pulumi.

## Plan, deploy and destroy

- `hull plan --env <name>` is the deploy pipeline stopped before any
  mutation: pre-flight, then the engine's preview rendered as one line
  per resource it would create, update or delete, the summary, then the
  environment's expected monthly figure with and without free tier. It
  needs credentials and changes nothing. The deploy engine interface
  gains `preview`, implemented over the Automation API's preview, whose
  events are the ones the engine already maps.
- `hull deploy --env <name>` shows that plan and the figure and asks to
  proceed. `--yes` answers for scripts; a non-interactive terminal
  without it is refused in pre-flight, never a silent deploy.
- The studio runs the same three operations for the selected environment:
  a plan view; a deploy button that shows the plan and the figure, asks,
  then streams progress, one row per resource, the summary and the API URL
  at the end; a destroy button behind a confirmation naming the
  environment. Progress travels over the WebSocket the dashboard already
  has. One operation at a time, and edits are refused while one runs.
- The package rule holds: the studio never knows Pulumi. The CLI hands the
  studio server an operator (plan, deploy, destroy) built from the same
  functions its own commands use, the way it hands the bindings writer
  today. The studio's tests run it with a fake operator, as the CLI's run
  with a fake engine.
- The CLI still knows no cost model: the figure `hull plan` prints comes
  from the estimate function the studio package already serves.

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

### Phase 2: studio as the editor

- Start screen and `hull init --template`.
- Inspector for the selected intent or link, and the header panel.
- What this deploys: resources per resolution as catalog data, with
  their estimate lines, checked against the compiler.
- Add and remove intents and links; overrides in the inspector; the
  worker's recommendation.

Exit: the demo blueprint can be built from an empty folder in the
dashboard alone, and the file diff is exactly the added intents and links.

### Phase 3: compiler and bindings

- Queue, dead-letter queue, worker, event source mapping, IAM per link,
  under the mock runtime.
- Queue bindings on both sides; the example's worker.

Exit: the demo blueprint compiles under the mock runtime and the example
typechecks against its bindings.

### Phase 4: plan, deploy, destroy, from both surfaces

- `hull plan`, the confirmation in `hull deploy`, the engine's preview.
- Operations from the studio with live progress.
- `dev` and `prod` side by side; the demo script twice, dashboard path
  and terminal path; the README.

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
- **An operation and an edit at the same time.** A deploy compiles the
  file as it was when it started; an edit during the run would make the
  dashboard lie about what is deploying. Edits are refused while an
  operation runs, and the file watcher's reload is deferred to its end.
- **Credentials in the studio process.** The studio runs in the
  developer's shell with the ambient profile, on localhost only, so the
  operations have exactly the access the terminal has. Nothing is stored.

## Out of scope for this milestone

Scheduled job, storage, user directory, secrets, web frontend, the
disaster recovery policy, `hull eject`, `hull dev`, raw-resource escape
hatch, GCP, hosted studio, IDE extension, observed-usage costs, FIFO
queues, fan-out (one message to many consumers), tier-to-tier links, KMS
secrets provider, publishing the schema at a public URL, operation history
kept across studio restarts, more than one operation at a time, editing
resources directly (the raw-resource escape hatch, milestone 3).
