import type { Blueprint, Op, UsageProfile } from "@hull/blueprint";
import type { ErrorResponse } from "./server.js";

// The dashboard's edits as operations for PUT /blueprint: the usage profile
// numbers and an intent's resolution, the only editable fields in v0. Kept
// out of the package's exports: the client imports this module directly.

export type UsageField = keyof UsageProfile;

// What the dashboard shows next to a field the studio refused: one line per
// diagnostic, none when the edit was accepted.
export type Refusal = string[];

// The estimate shows the usage profile merged for one environment, so the
// edit changes the line that value came from: the environment's own usage
// line when it sets the field (mergeEnvironment's rule: a field left out
// falls through to the blueprint's), the blueprint's line otherwise.
export function usageEdit(blueprint: Blueprint, environment: string, field: UsageField, value: number): Op {
  const ownValue = blueprint.environments[environment]?.usage?.[field];
  const path = ownValue === undefined ? ["usage", field] : ["environments", environment, "usage", field];
  return { op: "set", path, value };
}

export function resolutionEdit(intent: string, resolution: string): Op {
  return { op: "set", path: ["intents", intent, "resolution"], value: resolution };
}

// The refusal for an edit at `path`: the diagnostics at that path; failing
// that, every diagnostic with where it is, since a change to one line can
// break another; failing that, the error itself (a path the text cannot
// take, a body the studio cannot read).
export function refusalAt(path: Op["path"], response: ErrorResponse): Refusal {
  const diagnostics = response.diagnostics ?? [];
  const key = path.join(".");
  const here = diagnostics.filter((diagnostic) => diagnostic.path.join(".") === key);
  if (here.length > 0) return here.map((diagnostic) => diagnostic.message);
  if (diagnostics.length > 0) return diagnostics.map((diagnostic) => `${diagnostic.path.join(".")}: ${diagnostic.message}`);
  return [response.error];
}
