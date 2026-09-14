import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { blueprintFileName, loadBlueprint, type Blueprint } from "@hull/blueprint";
import { writeBindings } from "@hull/compiler/bindings";
import { resolveEnvironment, vocabulary } from "@hull/compiler/resolve";
import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import type { StackTarget } from "../deploy/engine.js";
import { renderProgress } from "../deploy/progress.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";
import { generatePassphrase, passphraseFileName, readPassphrase, readState, stateFileName, writeState } from "../deploy/state.js";

// The state bucket in the developer's account, one per account and region.
const stateBucketName = (account: string, region: string) => `hull-state-${account}-${region}`;

export function deployCommand({ cwd, output, engine = pulumiEngine(), provider = awsAccount() }: CommandContext) {
  return defineCommand({
    meta: {
      name: "deploy",
      description: "Deploy the blueprint to an environment in your own AWS account",
    },
    args: {
      env: {
        type: "string",
        description: "The environment to deploy, as named in hull.yaml",
        required: true,
      },
    },
    async run({ args }) {
      // Pre-flight, local checks first so nothing reaches the cloud until
      // the blueprint could deploy: the engine, the blueprint, its entry
      // files, the passphrase. Then the account.
      await engine.check();
      const blueprint = loadValidBlueprint(cwd);
      const merged = resolveEnvironment(blueprint, args.env);
      if (!merged) {
        const names = Object.keys(blueprint.environments).join(", ");
        throw new Error(`no environment "${args.env}" in ${blueprintFileName}; environments are ${names}`);
      }
      const entries = Object.entries(blueprint.intents).flatMap(([name, intent]) =>
        intent.kind === "http-api" ? [{ name, entry: intent.entry }] : [],
      );
      for (const { name, entry } of entries) {
        if (!existsSync(join(cwd, entry))) {
          throw new Error(`no entry ${entry} for intent ${name}; ${blueprintFileName} points at a file that does not exist`);
        }
      }
      const recorded = readState(cwd);
      let passphrase = readPassphrase(cwd);
      if (recorded && passphrase === undefined) {
        throw new Error(
          `no ${passphraseFileName}, but ${stateFileName} records the state bucket ${recorded.stateBucket}: this environment was deployed before and its state is locked with that passphrase. Copy ${passphraseFileName} from the machine that first deployed; Hull never regenerates it.`,
        );
      }

      const { account, profile } = await provider.identity(blueprint.region);
      output(`Deploying ${blueprint.name} to ${args.env} in ${blueprint.region} (account ${account}, profile ${profile}).`);

      const stateBucket = recorded?.stateBucket ?? stateBucketName(account, blueprint.region);
      const bucket = await provider.ensureStateBucket(stateBucket, blueprint.region);
      if (!recorded) writeState(cwd, { stateBucket });
      output(
        bucket === "created"
          ? `Created the state bucket ${stateBucket} and recorded it in ${stateFileName}; commit that file.`
          : `State bucket ${stateBucket}.`,
      );
      if (passphrase === undefined) {
        passphrase = generatePassphrase(cwd);
        output(`Generated the deploy secrets passphrase in ${passphraseFileName}; keep it, it unlocks this environment's state.`);
      }

      // Bindings first: the tier imports them, so the bundle carries the
      // module this blueprint implies, not a stale or missing one. The
      // compiler loads Pulumi's SDK; only deploy pays for it.
      for (const written of writeBindings(cwd, blueprint)) output(`Wrote ${relative(cwd, written)}.`);
      const { bundleEntry, compileProgram } = await import("@hull/compiler");
      const bundles = Object.fromEntries(
        await Promise.all(entries.map(async ({ name, entry }) => [name, await bundleEntry({ directory: cwd, entry })] as const)),
      );
      const program = compileProgram({ blueprint: merged, bundles });

      const target: StackTarget = {
        project: blueprint.name,
        stack: args.env,
        region: blueprint.region,
        backendUrl: `s3://${stateBucket}?region=${blueprint.region}`,
        passphrase,
      };
      const outputs = await engine.up(target, program, (event) => output(renderProgress(event)));

      const apiUrl = outputs.apiUrl;
      if (typeof apiUrl === "string") {
        output(`API URL: ${apiUrl}`);
        output(`Try: curl ${apiUrl}/todos`);
      }
    },
  });
}

function loadValidBlueprint(directory: string): Blueprint {
  const path = join(directory, blueprintFileName);
  if (!existsSync(path)) throw new Error(`no ${blueprintFileName} in ${directory}; run \`hull init\` first`);
  const loaded = loadBlueprint(readFileSync(path, "utf8"), vocabulary);
  if (!loaded.blueprint) {
    const lines = loaded.diagnostics.map(({ path, message }) => `  ${path.length > 0 ? path.join(".") : "(file)"}: ${message}`);
    throw new Error(`${blueprintFileName} is not valid:\n${lines.join("\n")}`);
  }
  return loaded.blueprint;
}
