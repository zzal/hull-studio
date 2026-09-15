import { parseDocument } from "yaml";
import { blueprintSchema, isTier, type Blueprint } from "./model.js";
import { sizingValueHasType, type Vocabulary } from "./vocabulary.js";

// The blueprint's file name at the root of the application repository.
export const blueprintFileName = "hull.yaml";

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

// "X is not a <noun> of <scope>; <nouns> are a, b". Every vocabulary rule says
// what is allowed, so a hand edit is fixable without guessing.
function notAmong(value: string, noun: string, scope: string, allowed: readonly string[]): string {
  const article = /^[aeiou]/.test(noun) ? "an" : "a";
  const list = allowed.length > 0 ? `${noun}s are ${allowed.join(", ")}` : `${scope} has no ${noun}s`;
  return `"${value}" is not ${article} ${noun} of ${scope}; ${list}`;
}

function checkVocabulary(blueprint: Blueprint, vocabulary: Vocabulary): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const intentNames = Object.keys(blueprint.intents);
  // Intents whose resolution is already reported; their overrides cannot be
  // checked against sizing parameters, and a second diagnostic would be noise.
  const unresolvable = new Set<string>();
  // A kind a link can target is one that defines link roles; a tier defines
  // none, so a tier never links to a tier (milestone 2 rule).
  const linkableKinds = Object.entries(vocabulary.kinds)
    .filter(([, { roles }]) => roles.length > 0)
    .map(([kind]) => kind);
  // The tier consuming each queue, so a second consumer is refused naming
  // the first.
  const consumers = new Map<string, string>();

  for (const [name, intent] of Object.entries(blueprint.intents)) {
    const candidates = Object.entries(vocabulary.resolutions)
      .filter(([, r]) => r.kind === intent.kind && r.provider === blueprint.provider)
      .map(([resolutionName]) => resolutionName);
    if (!candidates.includes(intent.resolution)) {
      unresolvable.add(name);
      diagnostics.push({
        path: ["intents", name, "resolution"],
        message: notAmong(
          intent.resolution,
          "candidate resolution",
          `kind ${intent.kind} on provider ${blueprint.provider}`,
          candidates,
        ),
      });
    }

    if (!isTier(intent)) continue;
    intent.links?.forEach((link, index) => {
      const target = blueprint.intents[link.to];
      if (!target) {
        diagnostics.push({
          path: ["intents", name, "links", index, "to"],
          message: notAmong(link.to, "intent", "this blueprint", intentNames),
        });
        return;
      }
      if (!linkableKinds.includes(target.kind)) {
        diagnostics.push({
          path: ["intents", name, "links", index, "to"],
          message: `"${link.to}" is of kind ${target.kind}, which a link cannot target; a link targets an intent of kind ${linkableKinds.join(", ")}`,
        });
        return;
      }
      const roles = vocabulary.kinds[target.kind].roles;
      if (!roles.includes(link.role)) {
        diagnostics.push({
          path: ["intents", name, "links", index, "role"],
          message: notAmong(link.role, "link role", `kind ${target.kind}`, roles),
        });
        return;
      }
      if (target.kind === "queue" && link.role === "consume") {
        const first = consumers.get(link.to);
        if (first === undefined) consumers.set(link.to, name);
        else {
          diagnostics.push({
            path: ["intents", name, "links", index, "role"],
            message: `queue "${link.to}" is consumed by both "${first}" and "${name}"; a queue has at most one consuming tier`,
          });
        }
      }
    });
  }

  for (const [environmentName, environment] of Object.entries(blueprint.environments)) {
    for (const [intentName, overrides] of Object.entries(environment.overrides ?? {})) {
      const intent = blueprint.intents[intentName];
      if (!intent) {
        diagnostics.push({
          path: ["environments", environmentName, "overrides", intentName],
          message: notAmong(intentName, "intent", "this blueprint", intentNames),
        });
        continue;
      }
      if (unresolvable.has(intentName)) continue;
      const parameters = vocabulary.resolutions[intent.resolution]?.sizingParameters ?? {};
      for (const [parameter, value] of Object.entries(overrides)) {
        const path = ["environments", environmentName, "overrides", intentName, parameter];
        const type = parameters[parameter];
        if (type === undefined) {
          diagnostics.push({
            path,
            message: notAmong(parameter, "sizing parameter", `resolution ${intent.resolution}`, Object.keys(parameters)),
          });
        } else if (!sizingValueHasType(value, type)) {
          diagnostics.push({
            path,
            message: `sizing parameter ${parameter} of resolution ${intent.resolution} takes a ${type}, not ${JSON.stringify(value)}`,
          });
        }
      }
    }
  }

  return diagnostics;
}
