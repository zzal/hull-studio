# Milestone 1: proof of concept

Two intents end to end, happy path only, cheap to test.

## Goal

Prove the whole loop on the smallest useful application: an HTTP API on
Lambda + API Gateway talking to a relational database on RDS Postgres.

The demo script this milestone must make true, in one terminal, on a fresh
AWS account:

```bash
hull init                 # writes hull.yaml with the two intents and a link
hull studio               # dashboard: 2 nodes, 1 link, estimate, recommendation
hull deploy --env dev     # compiles to Pulumi, deploys, generates bindings
curl https://<api>/todos  # the API reads from the database through its binding
hull destroy --env dev    # everything gone, bill stays near zero
```

Everything else in the glossary (queue, worker, DR policy, GCP, eject,
raw-resource escape hatch) is milestone 2 or 3.

## Repository layout

pnpm workspace, TypeScript everywhere, one `tsconfig.base.json`, Vitest.

```
@hull/
  CONTEXT.md
  docs/
    adr/
    milestones/
    schema/            # published JSON Schema (v0) — the file the IDEs fetch
  packages/
    blueprint/         # @hull/blueprint  — YAML load/save, validation, schema
    catalog/           # @hull/catalog    — intents, resolutions, sizing, cost, rules
    compiler/          # @hull/compiler   — blueprint -> Pulumi program, bindings
    studio/            # @hull/studio     — local server + React dashboard
    cli/               # @hull/cli        — `hull` binary
  examples/
    todos/             # the PoC app used by the demo script
```

Five packages is the minimum that keeps the four risky concerns separated
(round trip, cost, compile, UI). No shared "core" package yet; the
blueprint types are the shared vocabulary.

### Package responsibilities

| Package | Owns | Must not know about |
|---|---|---|
| `blueprint` | `hull.yaml` parse and save with comments preserved, Zod model, JSON Schema export, environment resolution (merge env overrides onto the base) | AWS, Pulumi, pricing |
| `catalog` | The nine intents' vocabulary (only two implemented), candidate resolutions per provider, valid roles per intent, sizing derivation from usage profile, cost models, pricing snapshot, recommendation rules | Pulumi, the file format, the UI |
| `compiler` | Turns a resolved blueprint for one environment into an inline Pulumi program, bundles tier code with esbuild, emits the binding module and the env-var contract | The UI, YAML |
| `studio` | HTTP + WebSocket server over the blueprint, React dashboard (graph, estimate, recommendation panel), writes changes back through `blueprint` | Pulumi |
| `cli` | `init`, `studio`, `deploy`, `destroy`; Pulumi Automation API driver; S3 state backend bootstrap | Cost models, UI |

Dependency direction: `cli -> studio, compiler -> catalog -> blueprint`.
`studio -> catalog -> blueprint`. Nothing points back.

## Blueprint v0

The schema covers exactly what the PoC needs. Every key below is
deliberately in the language of the glossary, never of AWS, except the
`resolution` values, which are provider-specific by definition.

```yaml
# $schema: https://hull.dev/schema/v0/hull.json
# yaml-language-server: $schema=https://hull.dev/schema/v0/hull.json

name: todos
provider: aws
region: us-east-1

usage:                       # usage profile, low-end defaults from `hull init`
  requestsPerMonth: 100000
  storageGb: 1

intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
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
    overrides:
      db:
        instanceClass: db.t4g.small
```

Rules the schema and validator enforce:

- `resolution` is required and must be a candidate for that `kind` on that
  `provider` (ADR 0002, 0003).
- `environments.*` may contain only `usage`, `policies` (empty in v0) and
  `overrides` (ADR 0005). No `kind`, no `resolution`.
- `overrides.<intent>.<param>` keys must be sizing parameters the
  resolution declares; anything else is a validation error, not a passthrough.
- `links[].role` must be a valid role for the target intent's kind. In v0,
  `relational-database` accepts only `read-write`.
- `entry` is required for `http-api` and must exist on disk at deploy time.

Schema generation: Zod 4 model in `blueprint`, exported to JSON Schema with
`z.toJSONSchema`, written to `docs/schema/v0/hull.json`. Publishing it at
`hull.dev` and registering `hull.yaml` on SchemaStore is a release task,
not a PoC task; until then `hull init` writes a `file://` path to the
schema inside `node_modules`, which both IDEs accept.

## Catalog v0

Two intents, three resolutions. The third exists only so the
recommendation panel has something real to compare.

| Intent kind | Resolution | Deployable in PoC | Sizing parameters |
|---|---|---|---|
| `http-api` | `lambda-api-gateway` | yes | `memoryMb`, `timeoutSeconds` |
| `http-api` | `fargate-load-balancer` | no (cost model and rules only) | `cpu`, `memoryMb`, `desiredCount` |
| `relational-database` | `rds-postgres` | yes | `instanceClass`, `storageGb`, `multiAz` |

Sizing derivation is a pure function `(resolution, usageProfile) -> sizing`.
The low-end profile yields 512 MB / 10 s for Lambda and `db.t4g.micro` /
20 GB / single-AZ for RDS.

Cost model is a pure function `(resolution, sizing, usageProfile, pricing)
-> { low, expected, high }`, computed twice: with and without free tier.
The pricing snapshot is a JSON file in the package covering only the SKUs
these three resolutions use, refreshed by a script against the AWS Price
List Bulk API and committed with the catalog version. The AWS free tier
changed shape in 2025 (credit-based for new accounts); the pricing task
must confirm the current rules before encoding "with free tier".

Recommendation rules for `http-api` compare the two resolutions on the
trade-off dimensions: cost at the current profile, ops burden, scaling
ceiling, cold start. The rule output is a ranked list with a one-line
reason per dimension. The studio shows it; it never changes the file.

## Compiler and deploy

- Input: the blueprint merged for one environment (from `blueprint`),
  plus derived sizing (from `catalog`).
- Output: an inline Pulumi program (a function, not files on disk) run
  through `LocalWorkspace` in the Automation API, with the backend set to
  `s3://<bucket>` in the user's account. `hull deploy` creates that bucket
  on first run if it is missing and records its name in `.hull/state.json`.
- Each `Link` becomes exactly one IAM statement set plus one group of env
  vars on the source tier. For `api -> db (read-write)` in v0 that means a
  security-group rule from the Lambda to the RDS instance and the
  connection env vars; IAM is trivial for Postgres over the network, which
  is why this pair was chosen for the PoC.
- Tier code is bundled with esbuild into one Lambda handler.
- The env-var contract for a database link is `HULL_<INTENT>_HOST`,
  `_PORT`, `_NAME`, `_USER`, `_PASSWORD_ARN` (Secrets Manager ARN of the RDS
  managed master password). Cross-language by construction.
- The binding module is generated at `.hull/bindings/index.ts` on every
  deploy and on every studio save. It exports one object per linked intent,
  typed by role: `db.connectionString()` resolves the secret and caches it.
  The folder is gitignored and never hand-edited (Prisma rule).
- Networking for the PoC: default VPC, RDS not publicly accessible, Lambda
  attached to the VPC. No NAT gateway, because the Lambda only needs the
  database. A NAT would be the single largest line on the bill.

Pulumi CLI must be installed on the machine; the Automation API drives it.
`hull deploy` checks for it and prints the install command if missing.

## Studio v0

- Server: Hono on `localhost`, random free port, opened in the browser by
  the CLI. Routes: `GET /blueprint` (parsed model + validation), `PUT
  /blueprint` (a patch; server applies it through the comment-preserving
  document and writes the file), `GET /estimate`, `GET /recommendations`,
  WebSocket push when the file changes on disk (chokidar).
- Client: React + Vite, graph drawn with React Flow. Three panels:
  the graph (nodes for the two intents, one edge labelled `read-write`),
  the estimate (per intent and total, low/expected/high, free-tier toggle),
  the recommendation card for the `api` node.
- Editable in v0: usage profile numbers and the `api` resolution. Both
  round-trip to the file with comments intact. Nothing else is editable in
  the PoC; adding intents from the studio is milestone 2.

## Phases

Ordered so the two riskiest pieces are proven before anything depends on
them.

### Phase 0: spikes (no packages yet, throwaway code)

1. Comment-preserving round trip. Load the sample blueprint above with the
   `yaml` package Document API, change `usage.requestsPerMonth` and
   `intents.api.resolution`, save. Diff must touch only those two lines.
   **Done, 2026-09-12: passes with a hybrid.** Scalar edits on existing
   keys are spliced by source range (byte-exact). Structural edits go
   through the Document API, which normalizes comment spacing once on
   hand-formatted files and is idempotent after that, so `hull init`
   writes the canonical form. Prototype and full findings on branch
   `prototype/yaml-round-trip` under `prototypes/yaml-round-trip/`.
2. Automation API smoke test. Inline program that creates one S3 bucket
   with an S3 backend, `up` then `destroy`, from a TypeScript script.
   **Done, 2026-09-12: passes.** About 20 s end to end including state
   bucket bootstrap and teardown. The project backend URL overrides a
   Pulumi Cloud login, `PulumiCommand.install()` covers users without the
   CLI, and `onEvent` gives per-resource progress. Open decision: who
   holds the passphrase for the secrets provider. Prototype and findings
   on branch `prototype/pulumi-automation` under
   `prototypes/pulumi-automation/`.

Exit: both scripts work. If (1) fails on the `yaml` package, evaluate
patching via `yaml` CST before considering any other format.

### Phase 1: blueprint and catalog

- Zod model, JSON Schema export, validation rules listed above.
- Environment merge.
- Catalog with the three resolutions, sizing derivation, cost models,
  pricing snapshot and refresh script, recommendation rules.
- Unit tests for every pure function; snapshot test on the JSON Schema.

Exit: `pnpm test` green; a script prints the estimate table for the sample
blueprint.

### Phase 2: CLI skeleton and studio

- `hull init` writes the sample blueprint with both schema comment lines.
- `hull studio` starts the server and opens the dashboard.
- Graph, estimate panel, recommendation card, the two editable fields.

Exit: editing the usage profile in the browser changes the number in
`hull.yaml` and the estimate updates; comments survive.

### Phase 3: compiler and deploy

- Pulumi program generation for the two resolutions and the link.
- esbuild bundling of the tier entry.
- Binding generation and the example app using it.
- `hull deploy --env dev`, `.hull/state.json`, S3 backend bootstrap.

Exit: the demo `curl` returns rows from Postgres.

### Phase 4: destroy and hardening of the happy path

- `hull destroy --env dev`.
- Error messages for the failures a first-time user will actually hit:
  no AWS credentials, no Pulumi CLI, entry file missing, invalid
  resolution for the provider.
- README with the demo script.

Exit: the full demo script runs twice in a row on a clean account.

## Test budget

Running the demo for an hour, then destroying:

| Line | Cost |
|---|---|
| Lambda + API Gateway at demo traffic | free tier |
| RDS `db.t4g.micro`, 20 GB gp3 | about $0.02 per hour, about $12 per month if left up |
| S3 state bucket | cents |
| NAT gateway | none, by design |

The rule for this milestone: never leave the dev environment up overnight.
`hull destroy` is part of every test run.

## Risks

- **Comment round trip** in the `yaml` Document API around sequence items
  and flow mappings. Mitigated by the phase 0 spike and by keeping the
  editable surface small.
- **Lambda in VPC cold starts** are fine now (Hyperplane ENIs), but the
  first deploy attaching the Lambda to the VPC can take a minute. Show
  progress from the Automation API event stream rather than a spinner.
- **RDS create time** is 5 to 10 minutes. Same mitigation.
- **Free tier definition** may differ from what the cost model assumes.
  Encode it as data in the pricing snapshot, not in code.
- **Pulumi CLI dependency** is a setup step Encore users never see. Accept
  it for the PoC; bundling the CLI is a distribution question for later.

## Out of scope for this milestone

Queue, worker, scheduled job, storage, user directory, secrets, web
frontend, DR policy, `--env prod`, overrides UI in the studio, adding or
removing intents from the studio, `hull eject`, `hull dev`, raw-resource
escape hatch, GCP, hosted studio, IDE extension, observed-usage costs.

## Defaults chosen without a decision record

These are implementation choices, not architecture; any can be swapped
later without touching the glossary or the ADRs.

- pnpm workspaces, Vitest, tsup for the JavaScript bundles, TypeScript 7
  (the native compiler, which has no JavaScript API) for typechecking and
  for declaration emit, since tsup's own dts step needs the old API.
  Workspace packages
  export their TypeScript source under the `@hull/source` condition, which
  the base tsconfig and the Vitest config select, so tests and typechecks
  never need a prior build; anything else resolving a workspace package
  (a Vite client build, a bundler) must select the same condition or it
  falls through to `dist`.
- `yaml` (eemeli) for the round trip; Zod 4 for the model and schema.
- Hono for the studio server, React + Vite + React Flow for the client.
- `citty` for the CLI.
- esbuild for tier bundling.
