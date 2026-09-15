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
  type LoadResult,
  type MergedBlueprint,
  type MergedSizing,
  type UsageProfile,
} from "@hull/blueprint";
import {
  CatalogError,
  deriveSizing,
  estimateEnvironment,
  pricing,
  recommendResolution,
  resolutionFacts,
  vocabulary,
  type Estimate,
  type IntentEstimate,
  type Recommendation,
  type SizedIntent,
} from "@hull/catalog";
import { Hono, type Context } from "hono";

export type StudioOptions = {
  // Directory holding hull.yaml.
  directory: string;
  // Called with the new model after a valid patch is written to the file.
  // Every studio save regenerates the bindings; the studio knows nothing of
  // how they are compiled, so `hull studio` plugs the compiler in here.
  onWrite?: (blueprint: Blueprint) => void;
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

export type ErrorResponse = { error: string; diagnostics?: Diagnostic[] };

// The studio HTTP API over one blueprint directory, as a Hono app so tests
// call it in-process; startStudio serves it with the dashboard.
export function createStudioServer({ directory, onWrite }: StudioOptions) {
  const app = new Hono();
  const file = join(directory, blueprintFileName);

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

  // PUT /blueprint with a list of operations: applied to the current text,
  // the result validated, then written only if valid and handed to onWrite.
  // The answer is what GET /blueprint would return afterwards.
  app.put("/blueprint", async (c) => {
    const current = readText();
    if (current === undefined) return missingBlueprint(c);
    const ops = opsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!ops.success) return c.json({ error: "body must be a list of set and delete operations" }, 400);

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
    writeFileSync(file, text);
    onWrite?.(loaded.blueprint);
    return c.json(loaded);
  });

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
              deployable: resolutionFacts(intent.resolution).deployable,
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
