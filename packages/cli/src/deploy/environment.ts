import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blueprintFileName, loadBlueprint, type Blueprint, type MergedBlueprint } from "@hull/blueprint";
import { resolveEnvironment, vocabulary } from "@hull/compiler/resolve";
import type { StackTarget } from "./engine.js";
import { passphraseFileName, readPassphrase, readState, stateFileName, type DeployState } from "./state.js";

// The pre-flight both `hull deploy` and `hull destroy` run before any cloud
// call, and the stack an environment maps to.

export type Environment = { name: string; blueprint: Blueprint; merged: MergedBlueprint };

export function loadEnvironment(directory: string, name: string): Environment {
  const blueprint = loadValidBlueprint(directory);
  const merged = resolveEnvironment(blueprint, name);
  if (!merged) {
    const names = Object.keys(blueprint.environments).join(", ");
    throw new Error(`no environment "${name}" in ${blueprintFileName}; environments are ${names}`);
  }
  return { name, blueprint, merged };
}

export function loadValidBlueprint(directory: string): Blueprint {
  const path = join(directory, blueprintFileName);
  if (!existsSync(path)) throw new Error(`no ${blueprintFileName} in ${directory}; run \`hull init\` first`);
  const loaded = loadBlueprint(readFileSync(path, "utf8"), vocabulary);
  if (!loaded.blueprint) {
    const lines = loaded.diagnostics.map(({ path, message }) => `  ${path.length > 0 ? path.join(".") : "(file)"}: ${message}`);
    throw new Error(`${blueprintFileName} is not valid:\n${lines.join("\n")}`);
  }
  return loaded.blueprint;
}

// The state file and the passphrase as they stand: nothing recorded (a
// passphrase may still exist, and deploy reuses it), or a bucket with its
// passphrase. The one combination refused is a recorded bucket whose
// passphrase is gone: that state is locked, and regenerating would lock it
// for good.
export type LocalState =
  | { recorded: undefined; passphrase: string | undefined }
  | { recorded: DeployState; passphrase: string };

export function readLocalState(directory: string): LocalState {
  const recorded = readState(directory);
  const passphrase = readPassphrase(directory);
  if (recorded === undefined) return { recorded, passphrase };
  if (passphrase === undefined) {
    throw new Error(
      `no ${passphraseFileName}, but ${stateFileName} records the state bucket ${recorded.stateBucket}: this environment was deployed before and its state is locked with that passphrase. Copy ${passphraseFileName} from the machine that first deployed; Hull never regenerates it.`,
    );
  }
  return { recorded, passphrase };
}

export function stackTarget({ name, blueprint }: Environment, stateBucket: string, passphrase: string): StackTarget {
  return {
    project: blueprint.name,
    stack: name,
    region: blueprint.region,
    backendUrl: `s3://${stateBucket}?region=${blueprint.region}`,
    passphrase,
  };
}
