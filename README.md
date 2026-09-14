# Hull

A dashboard-first cloud provisioner for developers who would rather describe
what their application needs than learn a cloud. You write intents in
`hull.yaml`, Hull picks and sizes the resources, shows you the cost, and deploys
with Pulumi into your own account.

See `CONTEXT.md` for the vocabulary, `docs/adr/` for the decisions, and
`docs/milestones/` for the plans.

## Status

Milestone 1, proof of concept: two intents (an HTTP API on Lambda plus API
Gateway, and a relational database on RDS Postgres) end to end, happy path
only. Everything else in the glossary is later.

## Repository layout

pnpm workspace, TypeScript 7 everywhere, one `tsconfig.base.json`, Vitest for
tests, tsup for the JavaScript bundles with declarations emitted by `tsc`.

| Package | Owns | Must not know about |
|---|---|---|
| `packages/blueprint` | `hull.yaml` load and save with comments preserved, Zod model, JSON Schema export, environment resolution | AWS, Pulumi, pricing |
| `packages/catalog` | Intents, candidate resolutions, sizing, cost models, pricing snapshot, recommendation rules | Pulumi, the file format, the UI |
| `packages/compiler` | Resolved blueprint to Pulumi program, tier bundling, binding module and env-var contract | The UI, YAML |
| `packages/studio` | Local HTTP and WebSocket server over the blueprint, React dashboard | Pulumi |
| `packages/cli` | The `hull` binary: `init`, `studio`, `deploy`, `destroy` | Cost models, UI |
| `examples/todos` | The proof-of-concept application the demo script deploys | |

Dependency direction: `cli -> studio, compiler -> catalog -> blueprint` and
`studio -> catalog -> blueprint`. Nothing points back. Direct edges to
`blueprint` are allowed anywhere downstream, since its types are the shared
vocabulary. The manifests declare the edges and
`tests/dependency-direction.test.ts` enforces them.

Workspace packages export their TypeScript source under the `@hull/source`
condition, so `pnpm test` and `pnpm typecheck` never need a prior build.

`packages/blueprint/schema/v0/hull.json` is the blueprint's JSON Schema,
exported from the Zod model, shipped with the package and snapshot-tested
(`pnpm vitest -u` refreshes it after a model change). Until it is published at
a public URL, `hull init` writes schema comment lines pointing at the installed
file, which JetBrains and the YAML language server both accept.

`packages/catalog/pricing/aws.json` is the pricing snapshot: the us-east-1
on-demand prices of exactly the sixteen SKUs the three v0 resolutions use
(including the Secrets Manager secret that holds the RDS managed master
password), refreshed from the AWS Price List Bulk API by
`pnpm -F @hull/catalog refresh-pricing`, with the free tier rules beside them
as data. The rules are verified by hand and dated in the file; the write-up
of the 2025 change to a credit-based free tier is in
`packages/catalog/README.md`. What is left for every account is the
always-free allowances, and of these SKUs only Lambda has one, so the
estimate's free-tier figure is labelled "always-free allowances only". The
allowances are one account-wide pool that the environment's intents draw
from in blueprint order.

The studio API serves `GET /blueprint` (model and diagnostics) and
`GET /estimate?environment=<name>` (the blueprint merged for that environment,
each sizing value marked derived or overridden, and the monthly low, expected
and high figures per intent and in total, with and without free tier).

`.hull/bindings/index.ts` is the binding module: generated from the blueprint
on every studio save (and, later, every deploy), one exported object per intent
a tier is linked to, typed by role. For the read-write database link, `db`
exposes `connectionString()`, which reads the link's `HULL_DB_*` variables,
fetches the managed master password once through the AWS SDK, keeps it for the
process lifetime and returns a Postgres URL with SSL required. The folder is
gitignored, every file carries a "generated, do not edit" header, and the
language-agnostic contract behind it is the environment variables the compiler
sets on the tier (`HULL_<INTENT>_HOST`, `_PORT`, `_NAME`, `_USER`,
`_PASSWORD_ARN`).

`examples/todos` is the application the demo deploys: a Hono app exporting a
Lambda `handler` whose `GET /todos` reaches Postgres through the binding. It
ships its `hull.yaml`; `pnpm typecheck` there regenerates the bindings first
(`pnpm bindings`), and `tests/todos-example.test.ts` bundles the entry and
typechecks the example against them.

`hull deploy --env <name>` runs the milestone's deploy path. Pre-flight, before
any cloud call: the Pulumi CLI is present, the blueprint is valid, every entry
file exists, and the passphrase is consistent with the state file. Then the
AWS identity is resolved from the ambient profile, the state bucket
`hull-state-<account>-<region>` is created if missing (region location
constraint, public access blocked, versioning on) and recorded in
`.hull/state.json`, which is committed so a second machine deploys against the
same state. The deploy secrets passphrase is generated on the first deploy into
the gitignored `.hull/passphrase`; a missing passphrase on a repository whose
state file already records a bucket is an error, never a silent regeneration.
The passphrase in a repository folder is a PoC choice; KMS is the intended
later secrets provider. The blueprint is then compiled, the bindings
regenerated, the tier bundled, and the program run through the deploy engine
with one line per resource event and a summary, ending with the API URL.

Pre-flight stops at the first failure with a message a first-time user can
act on: the Pulumi CLI missing (with the install command), the blueprint
invalid (the diagnostics), an entry file missing (the path), the passphrase
gone (where to copy it from), AWS credentials missing or expired (the profile
and region tried). None of these reaches the engine. When a deploy or a destroy fails
mid-way, the report names each failed resource with what the provider said
about it, or the engine's error line when no resource failed, and says what
to do next: Pulumi keeps what was created or removed in the environment's
state, so `hull deploy` again retries and `hull destroy` removes what is
there. The binary prints the message alone to stderr and exits 1; Pulumi's
own transcript never reaches the terminal.

`hull destroy --env <name>` is the other half: the same pre-flight minus the
entry files, then the engine removes every resource of the environment with
the same per-resource lines and summary, and removes the environment's state
from the backend. The state bucket, `.hull/state.json` and `.hull/passphrase`
are kept, so the next deploy is a first deploy on the same bucket and
passphrase. A directory with no state file has nothing to destroy and the
command says so before any cloud call. The program is written so that destroy
leaves nothing behind but the state bucket: the database takes no final
snapshot, and the Lambda's log group is declared rather than left for the
runtime to create outside the state.

Deploying twice on an unchanged blueprint is a no-op: the compiled program
declares the same resources with the same inputs and the bundle is
byte-identical, so Pulumi reports every resource unchanged. The test suite
checks this by running the program handed to the fake engine under Pulumi's
mock runtime on both runs and comparing what it declared.

The deploy engine is a small interface (`check`, `up`, `destroy`,
`removeStack`, a progress callback) in `packages/cli/src/deploy/engine.ts`,
implemented over the Pulumi Automation API as the second spike settled it:
the project backend URL points at the state bucket and overrides any Pulumi
Cloud login, the region is set in both the process environment and the
provider config, credentials come from the ambient AWS profile. Tests use a
fake engine and a fake account and never reach the network.

## Developing

Requires Node 22 or later and pnpm 10 (`corepack enable` picks the pinned
version).

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Prototype branches (`prototype/yaml-round-trip`, `prototype/pulumi-automation`)
are spikes with their verdicts in their READMEs. They are never merged.

## Acceptance test: the milestone 1 demo

The milestone is done when this script runs twice in a row, in one terminal,
on a fresh AWS account, with the Pulumi CLI installed and AWS credentials in
the ambient profile:

```bash
hull init                 # writes hull.yaml with the two intents and a link
hull studio               # dashboard: 2 nodes, 1 link, estimate, recommendation
hull deploy --env dev     # compiles to Pulumi, deploys, generates bindings
curl https://<api>/todos  # the API reads from the database through its binding
hull destroy --env dev    # everything gone, bill stays near zero
```

This path touches real AWS and is a manual test, not an automated one. The
automated suite never needs credentials or the network. Run the script twice
in the same directory: the second `hull deploy` finds the state bucket and
the passphrase from the first run, creates everything again from scratch
because `hull destroy` removed the stack, and `hull destroy` ends it again.
Afterwards, `aws s3 ls` shows the state bucket and nothing else, and the RDS,
Lambda and API Gateway consoles are empty. `examples/todos`
already carries its `hull.yaml` (the sample `hull init` writes, with the schema
comments pointing at the workspace's own schema file), so the script starts at
`hull studio` there; `hull init` is for a fresh directory.

Cost of a run: RDS `db.t4g.micro` is about two cents an hour (about $12 a
month if left up), Lambda and API Gateway sit in the free tier at demo
traffic, the S3 state bucket is cents, and there is no NAT gateway by design.
A deploy takes five to ten minutes, most of it the RDS instance; a destroy
takes a few minutes for the same reason. Never leave the dev environment up
overnight: `hull destroy --env dev` ends every run, and the state bucket it
keeps costs nothing worth mentioning.
