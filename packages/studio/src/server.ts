import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blueprintFileName,
  loadBlueprint,
  mergeEnvironment,
  sizingValues,
  type Diagnostic,
  type LoadResult,
  type MergedSizing,
  type UsageProfile,
} from "@hull/blueprint";
import { CatalogError, deriveSizing, estimateEnvironment, pricing, vocabulary, type Estimate } from "@hull/catalog";
import { Hono } from "hono";

export type StudioOptions = {
  // Directory holding hull.yaml.
  directory: string;
};

// GET /estimate?environment=<name>: the blueprint merged for that environment
// and its monthly estimate.
export type EstimateResponse = {
  environment: string;
  usage: UsageProfile;
  // How the free tier figures should be read until the pricing ticket
  // verifies the current rules.
  freeTierLabel: string;
  intents: Record<string, { resolution: string; sizing: MergedSizing } & Estimate>;
  total: Estimate;
};

export type ErrorResponse = { error: string; diagnostics?: Diagnostic[] };

// The studio HTTP API over one blueprint directory. Server only; the
// dashboard client lands with the dashboard ticket.
export function createStudioServer({ directory }: StudioOptions) {
  const app = new Hono();
  const file = join(directory, blueprintFileName);

  // Read on every request: the blueprint is the source of truth and the
  // developer's editor may have changed it since the last call.
  function read(): LoadResult | undefined {
    if (!existsSync(file)) return undefined;
    return loadBlueprint(readFileSync(file, "utf8"), vocabulary);
  }

  app.get("/blueprint", (c) => {
    const loaded = read();
    if (!loaded) return c.json({ error: `no ${blueprintFileName} in ${directory}` }, 404);
    return c.json(loaded);
  });

  app.get("/estimate", (c) => {
    const environmentName = c.req.query("environment");
    if (!environmentName) return c.json({ error: "environment query parameter is required" }, 400);

    const loaded = read();
    if (!loaded) return c.json({ error: `no ${blueprintFileName} in ${directory}` }, 404);
    if (!loaded.blueprint) {
      return c.json({ error: `${blueprintFileName} is not valid`, diagnostics: loaded.diagnostics }, 422);
    }

    const merged = mergeEnvironment(loaded.blueprint, environmentName, deriveSizing);
    if (!merged) {
      const names = Object.keys(loaded.blueprint.environments).join(", ");
      return c.json(
        { error: `no environment "${environmentName}" in ${blueprintFileName}; environments are ${names}` },
        404,
      );
    }

    try {
      const sized = Object.fromEntries(
        Object.entries(merged.intents).map(([name, intent]) => [
          name,
          { resolution: intent.resolution, sizing: sizingValues(intent.sizing) },
        ]),
      );
      const estimated = estimateEnvironment(sized, merged.usage, pricing);
      const response: EstimateResponse = {
        environment: merged.environment,
        usage: merged.usage,
        freeTierLabel: pricing.freeTier.label,
        intents: Object.fromEntries(
          Object.entries(merged.intents).map(([name, intent]) => [
            name,
            { resolution: intent.resolution, sizing: intent.sizing, ...estimated.intents[name]! },
          ]),
        ),
        total: estimated.total,
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof CatalogError) return c.json({ error: error.message }, 422);
      throw error;
    }
  });

  return app;
}
