import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOps,
  blueprintFileName,
  isTier,
  loadBlueprint,
  mergeEnvironment,
  opsSchema,
  PatchError,
  sizingValues,
  type Blueprint,
  type Diagnostic,
  type IntentKind,
  type LoadResult,
  type MergedBlueprint,
  type MergedSizing,
  type UsageProfile,
} from "@hull/blueprint";
import {
  candidatesOfKind,
  CatalogError,
  deriveSizing,
  estimateEnvironment,
  pricing,
  recommendForKind,
  recommendResolution,
  resolutionFacts,
  vocabulary,
  type Estimate,
  type IntentEstimate,
  type Recommendation,
  type ResolutionFacts,
  type SizedIntent,
} from "@hull/catalog";
import { Hono, type Context } from "hono";
import { createOperations, isOperationKind, operationKinds, type Operations } from "./operations.js";
import { BlueprintExistsError, createBlueprint, isTemplateName, notATemplate, templateNames, templates } from "./templates.js";

export type StudioOptions = {
  // Directory holding hull.yaml.
  directory: string;
  // Called with the new model after a valid patch is written to the file.
  // Every studio save regenerates the bindings; the studio knows nothing of
  // how they are compiled, so `hull studio` plugs the compiler in here.
  onWrite?: (blueprint: Blueprint) => void;
  // Plan, deploy and destroy, when the studio was started with an operator.
  operations?: Operations;
};

// GET /estimate?environment=<name>: the blueprint merged for that environment
// and its monthly estimate, per intent, per resource each intent implies, and
// in total.
export type EstimateResponse = {
  environment: string;
  usage: UsageProfile;
  // How the free tier figures should be read until the pricing ticket
  // verifies the current rules.
  freeTierLabel: string;
  intents: Record<string, { resolution: string; deployable: boolean; sizing: MergedSizing } & IntentEstimate>;
  total: Estimate;
};

// GET /recommendations?environment=<name>: for every intent whose kind has
// more than one candidate resolution, the candidates ranked at that
// environment's usage profile with one reason per trade-off dimension.
export type RecommendationsResponse = {
  environment: string;
  usage: UsageProfile;
  intents: Record<string, Recommendation>;
};

// GET /catalog?environment=<name>: what the palette and the inspector need
// from the catalog for the blueprint's provider: each kind's link roles, its
// candidate resolutions with what they imply, and the candidate a new intent
// of that kind gets at the environment's usage profile.
export type CatalogResponse = {
  provider: string;
  kinds: Record<IntentKind, { roles: readonly string[]; recommended: string; candidates: ResolutionFacts[] }>;
};

export type ErrorResponse = { error: string; diagnostics?: Diagnostic[] };

// The studio HTTP API over one blueprint directory, as a Hono app so tests
// call it in-process; startStudio serves it with the dashboard.
export function createStudioServer({ directory, onWrite, operations = createOperations() }: StudioOptions) {
  const app = new Hono();
  const file = join(directory, blueprintFileName);

  // While an operation runs the file must not change: a deploy compiles the
  // file as it was when it started, and an edit would make the dashboard
  // lie about what is deploying.
  const runningOperation = () => {
    const current = operations.current();
    return current?.status === "running" ? current : undefined;
  };

  // Read on every request: the blueprint is the source of truth and the
  // developer's editor may have changed it since the last call.
  function readText(): string | undefined {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  function read(): LoadResult | undefined {
    const text = readText();
    return text === undefined ? undefined : loadBlueprint(text, vocabulary);
  }

  const missingBlueprint = (c: Context) => c.json({ error: `no ${blueprintFileName} in ${directory}` }, 404);

  app.get("/blueprint", (c) => {
    const loaded = read();
    return loaded ? c.json(loaded) : missingBlueprint(c);
  });

  // The templates the start screen offers.
  app.get("/templates", (c) => c.json(templates));

  // POST /blueprint with a template name: writes the first hull.yaml, with
  // the .gitignore entries, and answers as GET /blueprint would afterwards.
  // Refused when the file exists; the studio never overwrites a blueprint.
  app.post("/blueprint", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { template?: unknown } | undefined;
    const template = body?.template;
    if (template === undefined) return c.json({ error: `body must name a template: ${templateNames.join(", ")}` }, 400);
    if (!isTemplateName(template)) return c.json({ error: notATemplate(String(template)) }, 400);
    try {
      createBlueprint(directory, template);
    } catch (error) {
      if (error instanceof BlueprintExistsError) return c.json({ error: error.message }, 409);
      throw error;
    }
    const loaded = read()!;
    if (loaded.blueprint) onWrite?.(loaded.blueprint);
    return c.json(loaded, 201);
  });

  // PUT /blueprint with a list of operations: applied to the current text,
  // the result validated, then written only if valid and handed to onWrite.
  // The answer is what GET /blueprint would return afterwards.
  app.put("/blueprint", async (c) => {
    const running = runningOperation();
    if (running) return c.json({ error: `a ${running.kind} of ${running.environment} is running; the blueprint cannot change until it ends` }, 409);
    const current = readText();
    if (current === undefined) return missingBlueprint(c);
    const ops = opsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!ops.success) return c.json({ error: "body must be a list of set, delete and rename operations" }, 400);

    let text: string;
    try {
      text = applyOps(current, ops.data);
    } catch (error) {
      if (error instanceof PatchError) return c.json({ error: error.message }, 400);
      throw error;
    }

    const loaded = loadBlueprint(text, vocabulary);
    if (!loaded.blueprint) {
      return c.json({ error: `the patch makes ${blueprintFileName} invalid`, diagnostics: loaded.diagnostics }, 422);
    }
    // An override the vocabulary accepts can still be one the catalog
    // refuses (memory 0, an unpriced instance class): refused here with the
    // estimate's own words, at the override, rather than written and shown
    // as a broken estimate.
    const unpriceable = checkSizing(loaded.blueprint);
    if (unpriceable) return c.json({ error: unpriceable.message, diagnostics: [unpriceable] }, 422);
    writeFileSync(file, text);
    onWrite?.(loaded.blueprint);
    return c.json(loaded);
  });

  // The first environment whose estimate the catalog refuses, as a
  // diagnostic at the intent's overrides in that environment.
  function checkSizing(blueprint: Blueprint): Diagnostic | undefined {
    for (const environmentName of Object.keys(blueprint.environments)) {
      const merged = mergeEnvironment(blueprint, environmentName, deriveSizing)!;
      const intents = sizedIntents(merged);
      for (const [name, intent] of Object.entries(intents)) {
        try {
          estimateEnvironment({ [name]: intent }, merged.usage, pricing);
        } catch (error) {
          if (!(error instanceof CatalogError)) throw error;
          const overridden = blueprint.environments[environmentName]?.overrides?.[name] !== undefined;
          return { path: overridden ? ["environments", environmentName, "overrides", name] : ["environments", environmentName], message: error.message };
        }
      }
    }
    return undefined;
  }

  // The blueprint merged for the environment named in the query, or the
  // response explaining why there is none: every route over one environment
  // answers the same way.
  function mergedFor(c: Context): { merged: MergedBlueprint } | { response: Response } {
    const environmentName = c.req.query("environment");
    if (!environmentName) return { response: c.json({ error: "environment query parameter is required" }, 400) };

    const loaded = read();
    if (!loaded) return { response: missingBlueprint(c) };
    if (!loaded.blueprint) {
      return {
        response: c.json({ error: `${blueprintFileName} is not valid`, diagnostics: loaded.diagnostics }, 422),
      };
    }

    const merged = mergeEnvironment(loaded.blueprint, environmentName, deriveSizing);
    if (!merged) {
      const names = Object.keys(loaded.blueprint.environments).join(", ");
      return {
        response: c.json(
          { error: `no environment "${environmentName}" in ${blueprintFileName}; environments are ${names}` },
          404,
        ),
      };
    }
    return { merged };
  }

  // The catalog's diagnostic for a rule the blueprint's content breaks;
  // anything else is a bug and propagates.
  function catalogResponse(c: Context, error: unknown): Response {
    if (error instanceof CatalogError) return c.json({ error: error.message }, 422);
    throw error;
  }

  function sizedIntents(merged: MergedBlueprint): Record<string, SizedIntent> {
    return Object.fromEntries(
      Object.entries(merged.intents).map(([name, intent]) => [
        name,
        { resolution: intent.resolution, sizing: sizingValues(intent.sizing), ...(isTier(intent) && intent.links && { links: intent.links }) },
      ]),
    );
  }

  app.get("/estimate", (c) => {
    const found = mergedFor(c);
    if ("response" in found) return found.response;
    const { merged } = found;

    try {
      const estimated = estimateEnvironment(sizedIntents(merged), merged.usage, pricing);
      const response: EstimateResponse = {
        environment: merged.environment,
        usage: merged.usage,
        freeTierLabel: pricing.freeTier.label,
        intents: Object.fromEntries(
          Object.entries(merged.intents).map(([name, intent]) => [
            name,
            {
              resolution: intent.resolution,
              deployable: resolutionFacts(intent.resolution, pricing).deployable,
              sizing: intent.sizing,
              ...estimated.intents[name]!,
            },
          ]),
        ),
        total: estimated.total,
      };
      return c.json(response);
    } catch (error) {
      return catalogResponse(c, error);
    }
  });

  app.get("/catalog", (c) => {
    const found = mergedFor(c);
    if ("response" in found) return found.response;
    const { merged } = found;

    const kinds = Object.fromEntries(
      Object.entries(vocabulary.kinds).map(([kind, { roles }]) => [
        kind,
        {
          roles,
          recommended: recommendForKind(kind as IntentKind, merged.provider, merged.usage, pricing),
          candidates: candidatesOfKind(kind as IntentKind, merged.provider, pricing),
        },
      ]),
    ) as CatalogResponse["kinds"];
    const response: CatalogResponse = { provider: merged.provider, kinds };
    return c.json(response);
  });

  // POST /operations with a kind and an environment: starts it in the
  // background and answers 202 with the operation; its progress and its end
  // travel over the WebSocket. 409 while one runs.
  app.post("/operations", async (c) => {
    if (!operations.available) return c.json({ error: "this studio cannot run operations; start it with `hull studio`" }, 503);
    const body = (await c.req.json().catch(() => undefined)) as { kind?: unknown; environment?: unknown } | undefined;
    if (!isOperationKind(body?.kind)) {
      return c.json({ error: `"${String(body?.kind)}" is not an operation; operations are ${operationKinds.join(", ")}` }, 400);
    }
    const environment = typeof body.environment === "string" ? body.environment : "";
    const loaded = read();
    if (!loaded) return missingBlueprint(c);
    if (!loaded.blueprint) return c.json({ error: `${blueprintFileName} is not valid`, diagnostics: loaded.diagnostics }, 422);
    if (!(environment in loaded.blueprint.environments)) {
      const names = Object.keys(loaded.blueprint.environments).join(", ");
      return c.json({ error: `no environment "${environment}" in ${blueprintFileName}; environments are ${names}` }, 404);
    }
    const running = runningOperation();
    if (running) return c.json({ error: `a ${running.kind} of ${running.environment} is running; wait for it to end` }, 409);
    return c.json(operations.start(body.kind, environment), 202);
  });

  // The last operation started, running or ended, with its events; null
  // when none ran since the studio started.
  app.get("/operations/current", (c) => c.json(operations.current() ?? null));

  app.get("/recommendations", (c) => {
    const found = mergedFor(c);
    if ("response" in found) return found.response;
    const { merged } = found;

    try {
      const intents: Record<string, Recommendation> = {};
      for (const [name, sized] of Object.entries(sizedIntents(merged))) {
        const recommendation = recommendResolution(sized, merged.usage, pricing);
        if (recommendation) intents[name] = recommendation;
      }
      const response: RecommendationsResponse = { environment: merged.environment, usage: merged.usage, intents };
      return c.json(response);
    } catch (error) {
      return catalogResponse(c, error);
    }
  });

  return app;
}
