import { isTier, sizingValues, type MergedBlueprint, type MergedSizing, type UsageProfile } from "@hull/blueprint";
import { estimateEnvironment, pricing, resolutionFacts, type Estimate, type IntentEstimate, type SizedIntent } from "@hull/catalog";
import type { PlanEstimate } from "./operations.js";

// The estimate of a blueprint merged for one environment, as the studio
// serves it and as `hull plan` prints it: the CLI knows no cost model, so
// the figure it shows comes from here.

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

// The intents as the catalog's estimate takes them: resolution, sizing
// values, and the links a linked intent's meter may read.
export function sizedIntents(merged: MergedBlueprint): Record<string, SizedIntent> {
  return Object.fromEntries(
    Object.entries(merged.intents).map(([name, intent]) => [
      name,
      { resolution: intent.resolution, sizing: sizingValues(intent.sizing), ...(isTier(intent) && intent.links && { links: intent.links }) },
    ]),
  );
}

// Throws a CatalogError for a sizing the catalog cannot price.
export function estimateMerged(merged: MergedBlueprint): EstimateResponse {
  const estimated = estimateEnvironment(sizedIntents(merged), merged.usage, pricing);
  return {
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
}

// The figure a plan shows: the environment's expected monthly total, with
// its range, and the same with the free tier.
export function planEstimate(estimate: EstimateResponse): PlanEstimate {
  const { total } = estimate;
  return {
    expected: total.withoutFreeTier.expected,
    low: total.withoutFreeTier.low,
    high: total.withoutFreeTier.high,
    withFreeTier: total.withFreeTier.expected,
    label: estimate.freeTierLabel,
  };
}

const money = (amount: number) => `$${amount.toFixed(2)}`;

// The figure as one line, for the CLI and the dashboard alike.
export function renderPlanEstimate(environment: string, estimate: PlanEstimate): string {
  return `Expected monthly figure for ${environment}: ${money(estimate.expected)} (low ${money(estimate.low)}, high ${money(estimate.high)}), or ${money(estimate.withFreeTier)} with ${estimate.label}.`;
}
