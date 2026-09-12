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
automated suite never needs credentials or the network.

Cost of a run: RDS `db.t4g.micro` is about two cents an hour, Lambda and API
Gateway sit in the free tier at demo traffic, the S3 state bucket is cents,
and there is no NAT gateway by design. Never leave the dev environment up
overnight; `hull destroy` ends every run.
