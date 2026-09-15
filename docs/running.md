# Running Hull

How to build the workspace, run the `hull` binary, run the tests, and run
the demo against a real AWS account. The repository README explains what
each package is; this page is only about running things.

## Prerequisites

- Node 22 or later and pnpm 10. `corepack enable` picks the pinned pnpm.
- The Pulumi CLI, for `hull deploy` and `hull destroy` only:
  `brew install pulumi` on macOS, or `curl -fsSL https://get.pulumi.com | sh`.
  No Pulumi account or login: state lives in your own S3 bucket.
- AWS credentials in the ambient profile, for deploy and destroy only:
  `aws sso login` or `aws configure`, then `export AWS_PROFILE=<name>` if it
  is not the default profile. A `.envrc` at the repo root is gitignored for
  this purpose (direnv).

Nothing else needs AWS: `hull init`, `hull studio` (until you plan or
deploy from it), the tests and the typecheck never touch the network.

## Build and check

```bash
pnpm install
pnpm build        # every package, dist/ per package
pnpm test         # Vitest, the whole workspace, no credentials needed
pnpm typecheck    # every package, plus the todos example against its bindings
```

Tests and typechecks resolve workspace packages from their TypeScript
source (the `@hull/source` export condition), so they do not need a prior
`pnpm build`. The binary does.

## The `hull` binary

Built, from anywhere in the workspace:

```bash
pnpm build
node packages/cli/dist/bin.js --help
```

From source, no build, slower to start:

```bash
pnpm exec tsx --conditions=@hull/source packages/cli/src/bin.ts --help
```

Both forms act on the current directory, so run them from the directory
that holds `hull.yaml`. To have `hull` on your PATH while developing:

```bash
pnpm build
cd packages/cli && pnpm link --global && cd -
hull --help
```

`pnpm unlink --global @hull/cli` removes it.

### Commands

| Command | What it does | Needs |
|---|---|---|
| `hull init [--template api-database\|blank]` | Writes a starting `hull.yaml` from a template (the API linked to a database, or an empty blueprint named after the folder) and the `.gitignore` entries | nothing |
| `hull studio [--port N]` | Starts the dashboard on localhost and opens the browser; in a folder without a blueprint it opens on a start screen. Every save rewrites the file with comments intact and regenerates `.hull/bindings`; plan, deploy and destroy run from the dashboard too | nothing to edit; Pulumi CLI and AWS credentials to plan or deploy |
| `hull plan --env <name>` | Shows what deploying that environment would create, update or delete, and its monthly figure, without creating any resource | Pulumi CLI, AWS credentials |
| `hull deploy --env <name> [--yes]` | Shows the plan and the figure, asks, then deploys into your AWS account with per-resource progress and the API URL at the end; `--yes` skips the question | Pulumi CLI, AWS credentials |
| `hull destroy --env <name>` | Removes every resource of that environment; keeps the state bucket, `.hull/state.json` and `.hull/passphrase` | Pulumi CLI, AWS credentials |

A failing command prints one message to stderr and exits 1. Pre-flight
stops before any cloud call when the Pulumi CLI is missing, the blueprint
is invalid, an entry file is missing, the passphrase is gone, no AWS
credentials resolve, or a deploy has no terminal to ask and no `--yes`.

## The demo: examples/todos

`examples/todos` is a Hono app whose `GET /todos` reads from Postgres
through the generated binding and whose `POST /todos` enqueues a title for
a Lambda worker, which writes the row. It carries its own `hull.yaml` (the
milestone 2 demo blueprint), so the terminal path starts at `hull plan`;
the dashboard path is in the README:

```bash
cd examples/todos
node ../../packages/cli/dist/bin.js studio             # look around, plan and deploy from there, or:
node ../../packages/cli/dist/bin.js plan --env dev     # what would be created, and the figure
node ../../packages/cli/dist/bin.js deploy --env dev   # shows the plan, asks; 5 to 10 minutes, mostly RDS
curl -X POST https://<api url printed above>/todos -d '{"title":"Ship milestone 2"}'
curl https://<api url printed above>/todos             # the worker's row is there
node ../../packages/cli/dist/bin.js deploy --env prod  # prod's sizing, its own stack
node ../../packages/cli/dist/bin.js destroy --env dev  # a few minutes each
node ../../packages/cli/dist/bin.js destroy --env prod
```

What it costs with both environments up: the two RDS instances are about
five cents an hour together (about USD 35 a month if forgotten); SQS,
Lambda and API Gateway are within the always-free allowances at demo
traffic; the state bucket is cents; there is no NAT gateway. Never leave
either environment up overnight: `hull destroy --env dev` and
`hull destroy --env prod` end every run.

Files the first deploy creates under `examples/todos/.hull`:

- `state.json`: the state bucket name. Meant to be committed so a second
  machine deploys against the same state. It contains your account id, so
  decide before committing it in a public repository.
- `passphrase`: unlocks the environment's state. Gitignored; never
  regenerated. Copy it to any other machine that deploys this environment.
- `bindings/`: generated, gitignored, rewritten on every save and deploy.

## Maintainer tasks

```bash
pnpm -F @hull/catalog refresh-pricing            # rewrite the pricing snapshot from the AWS Price List
pnpm vitest -u                                   # refresh the JSON Schema snapshot after a model change
pnpm -F todos bindings                           # regenerate the example's bindings without deploying
```

The pricing refresh needs the network but no credentials; see
`packages/catalog/README.md` for what it reads and how the free tier block
is maintained by hand.
