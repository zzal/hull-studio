import { parseDocument } from "yaml";
import { blueprintSchema, type Blueprint } from "./model.js";
import type { Vocabulary } from "./vocabulary.js";

export type Diagnostic = {
  // Location in the blueprint, as YAML path segments. Empty for the whole file.
  path: (string | number)[];
  message: string;
};

export type LoadResult =
  | { blueprint: Blueprint; diagnostics: [] }
  | { blueprint: null; diagnostics: Diagnostic[] };

// Load blueprint text into a validated model. Structural problems (YAML,
// shape) are reported first; the vocabulary rules run once the shape holds.
export function loadBlueprint(text: string, vocabulary: Vocabulary): LoadResult {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return {
      blueprint: null,
      diagnostics: document.errors.map((error) => ({ path: [], message: error.message })),
    };
  }

  const parsed = blueprintSchema.safeParse(document.toJS());
  if (!parsed.success) {
    return {
      blueprint: null,
      diagnostics: parsed.error.issues.flatMap((issue) => {
        const path = issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
        return issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => ({ path: [...path, key], message: issue.message }))
          : [{ path, message: issue.message }];
      }),
    };
  }

  const diagnostics = checkVocabulary(parsed.data, vocabulary);
  return diagnostics.length > 0
    ? { blueprint: null, diagnostics }
    : { blueprint: parsed.data, diagnostics: [] };
}

function checkVocabulary(blueprint: Blueprint, vocabulary: Vocabulary): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const intentNames = Object.keys(blueprint.intents);
  // Intents whose resolution is already reported; their overrides cannot be
  // checked against sizing parameters, and a second diagnostic would be noise.
  const unresolvable = new Set<string>();

  for (const [name, intent] of Object.entries(blueprint.intents)) {
    const candidates = Object.entries(vocabulary.resolutions)
      .filter(([, r]) => r.kind === intent.kind && r.provider === blueprint.provider)
      .map(([resolutionName]) => resolutionName);
    if (!candidates.includes(intent.resolution)) {
      unresolvable.add(name);
      diagnostics.push({
        path: ["intents", name, "resolution"],
        message: `"${intent.resolution}" is not a candidate resolution for kind ${intent.kind} on provider ${blueprint.provider}; candidates are ${candidates.join(", ")}`,
      });
    }

    if (intent.kind !== "http-api") continue;
    intent.links?.forEach((link, index) => {
      const target = blueprint.intents[link.to];
      if (!target) {
        diagnostics.push({
          path: ["intents", name, "links", index, "to"],
          message: `"${link.to}" is not an intent of this blueprint; intents are ${intentNames.join(", ")}`,
        });
        return;
      }
      const roles = vocabulary.kinds[target.kind].roles;
      if (!roles.includes(link.role)) {
        diagnostics.push({
          path: ["intents", name, "links", index, "role"],
          message: `"${link.role}" is not a role of kind ${target.kind}; roles are ${roles.join(", ")}`,
        });
      }
    });
  }

  for (const [environmentName, environment] of Object.entries(blueprint.environments)) {
    for (const [intentName, overrides] of Object.entries(environment.overrides ?? {})) {
      const intent = blueprint.intents[intentName];
      if (!intent) {
        diagnostics.push({
          path: ["environments", environmentName, "overrides", intentName],
          message: `"${intentName}" is not an intent of this blueprint; intents are ${intentNames.join(", ")}`,
        });
        continue;
      }
      if (unresolvable.has(intentName)) continue;
      const parameters = vocabulary.resolutions[intent.resolution]?.sizingParameters ?? [];
      for (const parameter of Object.keys(overrides)) {
        if (!parameters.includes(parameter)) {
          diagnostics.push({
            path: ["environments", environmentName, "overrides", intentName, parameter],
            message: `"${parameter}" is not a sizing parameter of resolution ${intent.resolution}; parameters are ${parameters.join(", ")}`,
          });
        }
      }
    }
  }

  return diagnostics;
}
