# PROTOTYPE: Pulumi Automation API smoke test (spike 2 of milestone 1)

Throwaway. Answers one question:

> From a TypeScript script, can `LocalWorkspace` with an inline program and
> an `s3://<bucket>` backend in the user's own AWS account run `up` then
> `destroy` for one trivial resource, streaming progress events? And what
> does the Pulumi CLI dependency look like in practice?

Run: `pnpm install && AWS_PROFILE=<sandbox profile> pnpm start`. Creates a
versioned state bucket, deploys one S3 bucket, destroys it, removes the
stack, and deletes the state bucket (set `KEEP_STATE_BUCKET=1` to keep it).
Cost: cents at most; the run leaves nothing behind.

## Verdict: yes, cleanly

Run of 2026-09-12 against account `aws-examples`, region ca-central-1:

| Step | Time |
|---|---|
| CLI check + STS identity | under 1 s |
| State bucket bootstrap (create, block public access, versioning) | 0.8 s |
| Workspace + stack creation on the S3 backend | 1.4 s |
| `up` (provider + one bucket) | 10.5 s |
| `destroy` | 3.5 s |
| Remove stack + delete state bucket (50 object versions) | 3 s |

Findings that matter for the CLI package:

- **CLI dependency.** `PulumiCommand.get()` found the Homebrew CLI
  (3.259.0) and accepted it alongside SDK 3.262.0, so an exact version
  match is not required. `PulumiCommand.install()` can download a pinned
  CLI into `~/.pulumi/versions/` for users who have none, which answers the
  "Encore users never see a CLI" distribution question without bundling.
- **Backend selection.** The user was logged into Pulumi Cloud (`pulumi
  whoami`), yet `projectSettings.backend.url = s3://...` took precedence
  with no login step. `whoAmI()` on the workspace confirms the S3 URL.
  Hull never touches the user's Pulumi Cloud account.
- **Secrets provider.** `secretsProvider: "passphrase"` plus
  `PULUMI_CONFIG_PASSPHRASE` in the workspace env is enough for the S3
  backend. Hull must own that passphrase (generate on `hull init`, store in
  `.hull/`, or use `awskms://` later). Left as a spec decision.
- **State bucket bootstrap** from the same script works with the AWS SDK:
  head, create with `LocationConstraint`, public access block, versioning.
  Deleting it needs every object version and delete marker removed first.
- **Event stream.** `onEvent` delivers `resourcePreEvent` and
  `resOutputsEvent` per resource with `op`, `type`, `urn`, plus a
  `summaryEvent` with the change counts and duration. That is enough to
  drive a per-resource progress view in the studio. All 21 diagnostic
  events were debug level.
- **Region** must be set both for the AWS SDK (`AWS_REGION`) and the
  provider (`aws:region` stack config). `up` also reads `AWS_PROFILE` from
  the workspace env, so no credential handling in Hull code.

Decision for `@hull/cli`: `LocalWorkspace.createOrSelectStack` with an
inline program, `s3://hull-state-<account>-<region>` bootstrapped on first
deploy, passphrase secrets provider, progress from `onEvent`.
