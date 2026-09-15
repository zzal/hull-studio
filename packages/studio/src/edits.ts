import { isTier, tierKinds, type Blueprint, type Intent, type IntentKind, type Op, type SizingValue, type UsageProfile } from "@hull/blueprint";
import type { ErrorResponse } from "./server.js";

// The dashboard's edits as operations for PUT /blueprint: every act in the
// header, the inspector and the palette is one list of operations, so the
// file never passes through an invalid state. Kept out of the package's
// exports: the client imports this module directly.

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

// A usage value for one environment only, whatever the blueprint says, and
// its reset back to the blueprint's value.
export function environmentUsageEdit(environment: string, field: UsageField, value: number): Op {
  return { op: "set", path: ["environments", environment, "usage", field], value };
}

export function resetEnvironmentUsageEdit(environment: string, field: UsageField): Op {
  return { op: "delete", path: ["environments", environment, "usage", field] };
}

export function resolutionEdit(intent: string, resolution: string): Op {
  return { op: "set", path: ["intents", intent, "resolution"], value: resolution };
}

export function entryEdit(intent: string, entry: string): Op {
  return { op: "set", path: ["intents", intent, "entry"], value: entry };
}

// The blueprint's header scalars; the provider is not editable.
export type HeaderField = "name" | "region";
export function headerEdit(field: HeaderField, value: string): Op {
  return { op: "set", path: [field], value };
}

// A rename rewrites the intent's key, every link's `to` that points at it,
// and its overrides in every environment, in one patch.
export function renameIntentEdit(blueprint: Blueprint, from: string, to: string): Op[] {
  const ops: Op[] = [{ op: "rename", path: ["intents", from], to }];
  for (const [tier, intent] of Object.entries(blueprint.intents)) {
    if (!isTier(intent)) continue;
    intent.links?.forEach((link, index) => {
      if (link.to === from) ops.push({ op: "set", path: ["intents", tier, "links", index, "to"], value: to });
    });
  }
  for (const [environment, { overrides }] of Object.entries(blueprint.environments)) {
    if (overrides && from in overrides) ops.push({ op: "rename", path: ["environments", environment, "overrides", from], to });
  }
  return ops;
}

// The name a new intent of each kind gets, then the first free numbered one.
const baseNames: Record<IntentKind, string> = {
  "http-api": "api",
  "relational-database": "db",
  queue: "queue",
  "background-worker": "worker",
};

function freeName(blueprint: Blueprint, kind: IntentKind): string {
  const base = baseNames[kind];
  if (!(base in blueprint.intents)) return base;
  for (let n = 2; ; n++) if (!(`${base}${n}` in blueprint.intents)) return `${base}${n}`;
}

// The palette's add: the intent with the resolution given (the recommended
// one), a generated name, and for a tier a placeholder entry path. The
// intent lands at the end of the section.
export function addIntentEdit(blueprint: Blueprint, kind: IntentKind, resolution: string): { name: string; op: Op } {
  const name = freeName(blueprint, kind);
  const value: Record<string, unknown> = { kind, resolution };
  if (tierKinds.includes(kind)) value.entry = `src/${name}/index.ts`;
  return { name, op: { op: "set", path: ["intents", name], value } };
}

function linksOf(intent: Intent | undefined) {
  return intent && isTier(intent) ? (intent.links ?? []) : [];
}

// A link drawn from a tier to an intent, with its role, as one operation
// appended after the tier's links.
export function addLinkEdit(blueprint: Blueprint, tier: string, to: string, role: string): Op {
  return { op: "set", path: ["intents", tier, "links", linksOf(blueprint.intents[tier]).length], value: { to, role } };
}

export function removeLinkEdit(tier: string, index: number): Op {
  return { op: "delete", path: ["intents", tier, "links", index] };
}

// Removing an intent removes its overrides with it; the links other tiers
// have to it stay, so the studio refuses the patch with their diagnostics
// rather than silently dropping them.
export function removeIntentEdit(blueprint: Blueprint, name: string): Op[] {
  const ops: Op[] = [{ op: "delete", path: ["intents", name] }];
  for (const [environment, { overrides }] of Object.entries(blueprint.environments)) {
    if (overrides && name in overrides) ops.push({ op: "delete", path: ["environments", environment, "overrides", name] });
  }
  return ops;
}

export function overrideEdit(environment: string, intent: string, parameter: string, value: SizingValue): Op {
  return { op: "set", path: ["environments", environment, "overrides", intent, parameter], value };
}

// The patch engine removes the mappings the reset leaves empty, up to
// `overrides`.
export function resetOverrideEdit(environment: string, intent: string, parameter: string): Op {
  return { op: "delete", path: ["environments", environment, "overrides", intent, parameter] };
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
