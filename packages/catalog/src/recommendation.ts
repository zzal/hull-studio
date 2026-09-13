import type { IntentKind, UsageProfile } from "@hull/blueprint";
import { candidatesOf, estimateEnvironment, type SizedIntent } from "./catalog.js";
import type { PricingSnapshot } from "./pricing.js";

// Recommendation rules: rank the candidate resolutions of one intent kind at
// a usage profile and say why, one line per trade-off dimension. Every rule
// is a readable table so a wrong recommendation is fixable by a pull request
// (ADR 0007). The rules only read the blueprint; applying a recommendation is
// the developer's act, never the catalog's.

export const dimensions = ["cost", "opsBurden", "scalingCeiling", "coldStart"] as const;
export type Dimension = (typeof dimensions)[number];

export type RankedResolution = {
  resolution: string;
  // Expected monthly figure at the profile, without free tier.
  expectedMonthly: number;
  reasons: Record<Dimension, string>;
};

export type Recommendation = {
  kind: IntentKind;
  // The blueprint's own resolution, reported beside the ranking: the
  // recommendation is proposed, never applied.
  current: string;
  recommended: string;
  ranking: RankedResolution[];
};

// Points a candidate earns by winning a dimension. Cost at the profile
// outweighs any single fixed property, and between the two http-api
// candidates the fixed properties split one against two, so in v0 the
// cheaper candidate leads and the other three lines say what it gives up. At
// equal cost the fixed properties decide. The rules assume two candidates per
// kind; a third needs per-dimension scores, not a flag.
const weights: Record<Dimension, number> = { cost: 2, opsBurden: 1, scalingCeiling: 1, coldStart: 1 };

// The fixed properties of each http-api resolution: whether it wins the
// dimension, and how to say it. Cost is not here because it is computed at
// the profile.
type FixedDimension = Exclude<Dimension, "cost">;
type Verdict = { wins: boolean; reason: string };
const httpApiProperties: Record<string, Record<FixedDimension, Verdict>> = {
  "lambda-api-gateway": {
    opsBurden: { wins: true, reason: "no servers, images or scaling policy to run; AWS patches the runtime" },
    scalingCeiling: {
      wins: false,
      reason: "scales per request up to the account's concurrency quota (1,000 by default), then throttles",
    },
    coldStart: {
      wins: false,
      reason: "a cold invocation after idle adds hundreds of milliseconds, so tail latency spikes at low traffic",
    },
  },
  "fargate-load-balancer": {
    opsBurden: { wins: false, reason: "a container image to build and patch, a cluster and a scaling policy to keep" },
    scalingCeiling: { wins: true, reason: "no per-request ceiling; capacity is the task count, raised by a scaling policy" },
    coldStart: { wins: true, reason: "always-on tasks answer without cold start" },
  },
};

const rulesByKind: Partial<Record<IntentKind, Record<string, Record<FixedDimension, Verdict>>>> = {
  "http-api": httpApiProperties,
};

type PricedCandidate = { resolution: string; expectedMonthly: number };

// Rank the candidates of the intent's kind on the intent's provider at the
// profile. The current resolution is priced as sized in the environment,
// overrides included, so this figure agrees with the estimate; the other
// candidates are priced at their derived sizing. Undefined for a kind with a
// single candidate: there is nothing to compare.
export function recommendResolution(
  current: SizedIntent,
  usage: UsageProfile,
  pricing: PricingSnapshot,
): Recommendation | undefined {
  const { kind, candidates } = candidatesOf(current.resolution, usage);
  const properties = rulesByKind[kind];
  if (!properties || candidates.length < 2) return undefined;

  // The expected figure without free tier: the free tier is one account-wide
  // pool drawn in intent order, so a figure with it would depend on the
  // other intents, not on the candidate.
  const priced: PricedCandidate[] = candidates.map((candidate) => ({
    resolution: candidate.resolution,
    expectedMonthly: estimateEnvironment(
      { candidate: candidate.resolution === current.resolution ? current : candidate },
      usage,
      pricing,
    ).total.withoutFreeTier.expected,
  }));
  const cheapest = priced.reduce((best, candidate) => (candidate.expectedMonthly < best.expectedMonthly ? candidate : best));

  const scored = priced.map(({ resolution, expectedMonthly }) => {
    const fixed = properties[resolution];
    if (!fixed) throw new Error(`no recommendation rule for ${resolution}`);
    const costDifference = expectedMonthly - cheapest.expectedMonthly;
    const cost: Verdict = {
      wins: costDifference === 0,
      reason: `${money(expectedMonthly)} a month expected at ${usage.requestsPerMonth.toLocaleString("en-US")} requests without free tier, ${
        costDifference === 0 ? "the cheapest at this profile" : `${money(costDifference)} more than ${cheapest.resolution}`
      }`,
    };
    const verdicts: Record<Dimension, Verdict> = { cost, ...fixed };
    const points = dimensions.reduce((sum, dimension) => sum + (verdicts[dimension].wins ? weights[dimension] : 0), 0);
    const reasons = Object.fromEntries(dimensions.map((dimension) => [dimension, verdicts[dimension].reason])) as Record<
      Dimension,
      string
    >;
    return { ranked: { resolution, expectedMonthly, reasons }, points };
  });

  // Stable: candidates keep catalog order at equal points.
  const ranking = scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .map(({ ranked }) => ranked);

  return { kind, current: current.resolution, recommended: ranking[0]!.resolution, ranking };
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
