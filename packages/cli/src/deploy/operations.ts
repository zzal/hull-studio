import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { blueprintFileName, isTier } from "@hull/blueprint";
import { writeBindings } from "@hull/compiler/bindings";
import { estimateMerged, planEstimate, renderPlanEstimate, type DeployOutcome, type OnProgress, type PlanOutcome, type ProgressEvent } from "@hull/studio";
import type { DeployEngine, ProviderAccount, StackTarget } from "./engine.js";
import { loadEnvironment, readLocalState, stackTarget, type Environment } from "./environment.js";
import { renderChanges, watchFailures } from "./progress.js";
import { generatePassphrase, passphraseFileName, stateBucketName, stateFileName, writeState } from "./state.js";

// Plan, deploy and destroy as functions: the commands print their progress
// as lines, the studio streams it to the dashboard, both through the same
// engine and account. Every line for the developer is a note event.

export type OperationContext = {
  cwd: string;
  engine: DeployEngine;
  provider: ProviderAccount;
  onProgress: OnProgress;
};

const note = (onProgress: OnProgress, message: string) => onProgress({ phase: "note", message });

type Prepared = { environment: Environment; target: StackTarget; entries: { name: string; entry: string }[] };

// Pre-flight, local checks first so nothing reaches the cloud until the
// blueprint could deploy: the engine, the blueprint, its entry files (when
// asked), the passphrase. Then the account and the state bucket. A plan
// changes nothing: on a directory never deployed from it neither creates
// the bucket nor the passphrase, and previews against an empty local state,
// which is what a first deploy would find.
async function prepare(
  { cwd, engine, provider, onProgress }: OperationContext,
  name: string,
  { intro, entryFiles, readOnly }: { intro: (application: string) => string; entryFiles: boolean; readOnly: boolean },
): Promise<Prepared> {
  await engine.check();
  const environment = loadEnvironment(cwd, name);
  const { blueprint } = environment;
  const entries = Object.entries(blueprint.intents).flatMap(([intentName, intent]) => (isTier(intent) ? [{ name: intentName, entry: intent.entry }] : []));
  if (entryFiles) {
    for (const { name: intentName, entry } of entries) {
      if (!existsSync(join(cwd, entry))) {
        throw new Error(`no entry ${entry} for intent ${intentName}; ${blueprintFileName} points at a file that does not exist`);
      }
    }
  }
  const { recorded, passphrase: existingPassphrase } = readLocalState(cwd);
  let passphrase = existingPassphrase;

  const { account, profile } = await provider.identity(blueprint.region);
  note(onProgress, `${intro(blueprint.name)} in ${blueprint.region} (account ${account}, profile ${profile}).`);

  if (readOnly && recorded === undefined) {
    note(onProgress, "Nothing was deployed from here yet; planning against an empty state.");
    const localBackend = `file://${mkdtempSync(join(tmpdir(), "hull-plan-"))}`;
    return { environment, target: { ...stackTarget(environment, "", "plan"), backendUrl: localBackend }, entries };
  }

  const stateBucket = recorded?.stateBucket ?? stateBucketName(account, blueprint.region);
  const bucket = await provider.ensureStateBucket(stateBucket, blueprint.region);
  if (!recorded) writeState(cwd, { stateBucket });
  note(
    onProgress,
    bucket === "created" ? `Created the state bucket ${stateBucket} and recorded it in ${stateFileName}; commit that file.` : `State bucket ${stateBucket}.`,
  );
  if (passphrase === undefined) {
    passphrase = generatePassphrase(cwd);
    note(onProgress, `Generated the deploy secrets passphrase in ${passphraseFileName}; keep it, it unlocks this environment's state.`);
  }
  return { environment, target: stackTarget(environment, stateBucket, passphrase), entries };
}

// Bindings first: the tier imports them, so the bundle carries the module
// this blueprint implies, not a stale or missing one. The compiler loads
// Pulumi's SDK; only plan and deploy pay for it.
async function compile({ cwd, onProgress }: OperationContext, { environment, entries }: Prepared) {
  for (const written of writeBindings(cwd, environment.blueprint)) note(onProgress, `Wrote ${relative(cwd, written)}.`);
  const { bundleEntry, compileProgram } = await import("@hull/compiler");
  const bundles = Object.fromEntries(
    await Promise.all(entries.map(async ({ name, entry }) => [name, await bundleEntry({ directory: cwd, entry })] as const)),
  );
  return compileProgram({ blueprint: environment.merged, bundles });
}

// The engine's preview rendered as one planned line per resource it would
// change, the change counts, then the environment's expected monthly figure
// from the estimate the studio serves.
async function preview(context: OperationContext, prepared: Prepared, program: Awaited<ReturnType<typeof compile>>): Promise<PlanOutcome> {
  const { engine, onProgress } = context;
  const { environment, target } = prepared;
  note(onProgress, `Plan for ${environment.blueprint.name} ${environment.name}:`);
  const forward = (event: ProgressEvent) => {
    if (event.phase === "done") {
      if (event.operation !== "same") onProgress({ phase: "planned", operation: event.operation, type: event.type, name: event.name });
    } else if (event.phase === "diagnostic") onProgress(event);
  };
  const { changes } = await engine.preview(target, program, forward).catch((error: unknown) => {
    throw new Error(`plan of ${environment.blueprint.name} ${environment.name} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  note(onProgress, renderChanges(changes));
  const estimate = planEstimate(estimateMerged(environment.merged));
  note(onProgress, renderPlanEstimate(environment.name, estimate));
  return { changes, estimate };
}

// `hull plan --env <name>`: the deploy pipeline stopped before any mutation.
export async function runPlan(context: OperationContext, name: string): Promise<PlanOutcome> {
  const prepared = await prepare(context, name, { intro: (application) => `Planning ${application} ${name}`, entryFiles: true, readOnly: true });
  const program = await compile(context, prepared);
  const outcome = await preview(context, prepared, program);
  note(context.onProgress, `Nothing was created; run \`hull deploy --env ${name}\` to proceed.`);
  return outcome;
}

// `hull deploy --env <name>`: the plan, the figure, the question, then the
// deploy. A failure mid-way leaves what was created in the environment's
// state; the report names the resources and what the provider said.
export async function runDeploy(context: OperationContext, name: string, confirm: (question: string) => Promise<boolean>): Promise<DeployOutcome> {
  const prepared = await prepare(context, name, { intro: (application) => `Deploying ${application} to ${name}`, entryFiles: true, readOnly: false });
  const program = await compile(context, prepared);
  await preview(context, prepared, program);
  const { environment, target } = prepared;
  if (!(await confirm(`Proceed with the deploy of ${environment.blueprint.name} ${name}?`))) throw new Error("deploy cancelled");

  const progress = watchFailures(context.onProgress);
  const advice = `What was created is recorded in the environment's state: run \`hull deploy --env ${name}\` again to retry, or \`hull destroy --env ${name}\` to remove it.`;
  const outputs = await context.engine.up(target, program, progress.onProgress).catch((error: unknown) => {
    throw progress.report(`deploy of ${environment.blueprint.name} ${name}`, error, advice);
  });
  const apiUrl = outputs.apiUrl;
  if (typeof apiUrl === "string") {
    note(context.onProgress, `API URL: ${apiUrl}`);
    note(context.onProgress, `Try: curl ${apiUrl}/todos`);
    return { apiUrl };
  }
  return {};
}

// `hull destroy --env <name>`: the same pre-flight minus the entry files
// (the code is removed with the environment), then the engine removes
// every resource and the environment's state; the bucket, the state file
// and the passphrase are kept.
export async function runDestroy({ cwd, engine, provider, onProgress }: OperationContext, name: string): Promise<void> {
  await engine.check();
  const environment = loadEnvironment(cwd, name);
  const local = readLocalState(cwd);
  if (local.recorded === undefined) {
    throw new Error(`nothing to destroy: no ${stateFileName} in ${cwd}, so nothing was deployed from here`);
  }
  const { recorded, passphrase } = local;
  const { blueprint } = environment;

  const { account, profile } = await provider.identity(blueprint.region);
  note(onProgress, `Destroying ${blueprint.name} ${name} in ${blueprint.region} (account ${account}, profile ${profile}).`);

  const target = stackTarget(environment, recorded.stateBucket, passphrase);
  const progress = watchFailures(onProgress);
  const operation = `destroy of ${blueprint.name} ${name}`;
  await engine.destroy(target, progress.onProgress).catch((error: unknown) => {
    throw progress.report(operation, error, `What was removed is recorded in the environment's state: run \`hull destroy --env ${name}\` again to remove the rest.`);
  });
  await engine.removeStack(target).catch((error: unknown) => {
    throw progress.report(operation, error, `Every resource is gone, but the environment's state is still in the bucket: run \`hull destroy --env ${name}\` again to remove it.`);
  });
  note(
    onProgress,
    `Removed ${name} from the state bucket ${recorded.stateBucket}; the bucket, ${stateFileName} and ${passphraseFileName} are kept, so the next deploy starts from scratch.`,
  );
}
