import type { IntentKind, Provider, UsageProfile, Vocabulary } from "@hull/blueprint";
import type { z } from "zod";
import { CatalogError, notAmong } from "./errors.js";
import { fargateLoadBalancerMeter, lambdaApiGatewayMeter, rdsPostgresMeter, scenarios, type Meter, type ScenarioName } from "./meters.js";
import { freshPool, priceLineItems, type PricingSnapshot } from "./pricing.js";
import {
  deriveFargateSizing,
  deriveLambdaSizing,
  deriveRdsSizing,
  fargateSizingSchema,
  lambdaSizingSchema,
  rdsSizingSchema,
  type Sizing,
} from "./sizing.js";

// Catalog v0: the two intent kinds and three resolutions of the milestone 1
// plan. One table per resolution binds its provider, kind, sizing parameters,
// derivation and cost model, so nothing else in the package switches on the
// resolution name. The third resolution exists so the recommendation has
// something real to compare; it is not deployable in v0.

type Resolution<S extends z.ZodObject> = {
  provider: Provider;
  kind: IntentKind;
  sizing: S;
  derive: (usage: UsageProfile) => z.infer<S>;
  meter: (sizing: z.infer<S>) => Meter;
};

function resolution<S extends z.ZodObject>(definition: Resolution<S>): Resolution<S> {
  return definition;
}

const resolutions = {
  "lambda-api-gateway": resolution({
    provider: "aws",
    kind: "http-api",
    sizing: lambdaSizingSchema,
    derive: deriveLambdaSizing,
    meter: lambdaApiGatewayMeter,
  }),
  "fargate-load-balancer": resolution({
    provider: "aws",
    kind: "http-api",
    sizing: fargateSizingSchema,
    derive: deriveFargateSizing,
    meter: fargateLoadBalancerMeter,
  }),
  "rds-postgres": resolution({
    provider: "aws",
    kind: "relational-database",
    sizing: rdsSizingSchema,
    derive: deriveRdsSizing,
    meter: rdsPostgresMeter,
  }),
};

const kinds: Vocabulary["kinds"] = {
  "http-api": { roles: [] },
  "relational-database": { roles: ["read-write"] },
};

export const vocabulary: Vocabulary = {
  kinds,
  resolutions: Object.fromEntries(
    Object.entries(resolutions).map(([name, { provider, kind, sizing }]) => [
      name,
      {
        provider,
        kind,
        sizingParameters: Object.fromEntries(
          Object.entries(sizing.shape).map(([parameter, schema]) => [parameter, schema.def.type]),
        ),
      },
    ]),
  ),
};

function resolutionNamed(name: string) {
  const definition = (resolutions as Record<string, Resolution<z.ZodObject>>)[name];
  if (!definition) throw new CatalogError(notAmong(name, "resolution", "this catalog", Object.keys(resolutions)));
  return definition;
}

export function deriveSizing(resolution: string, usage: UsageProfile): Sizing {
  // Looked up by name, the table no longer knows which sizing schema applies;
  // every schema's values are sizing values by construction.
  return resolutionNamed(resolution).derive(usage) as Sizing;
}

export type MonthlyRange = Record<ScenarioName, number>;
export type Estimate = { withoutFreeTier: MonthlyRange; withFreeTier: MonthlyRange };

export type SizedIntent = { resolution: string; sizing: Sizing };

export type EnvironmentEstimate<Name extends string = string> = {
  intents: Record<Name, Estimate>;
  total: Estimate;
};

const figures = [
  ["withoutFreeTier", false],
  ["withFreeTier", true],
] as const;
const scenarioEntries = Object.entries(scenarios) as [ScenarioName, (typeof scenarios)[ScenarioName]][];

const emptyRange = (): MonthlyRange => ({ low: 0, expected: 0, high: 0 });
const emptyEstimate = (): Estimate => ({ withoutFreeTier: emptyRange(), withFreeTier: emptyRange() });

// The monthly estimate of every intent and of the environment, as low /
// expected / high, with and without the free tier. Intents draw from one free
// tier pool in the order given, so the total never counts an allowance twice.
export function estimateEnvironment<Name extends string>(
  intents: Record<Name, SizedIntent>,
  usage: UsageProfile,
  pricing: PricingSnapshot,
): EnvironmentEstimate<Name> {
  const meters = Object.entries<SizedIntent>(intents).map(([name, { resolution, sizing }]) => {
    const definition = resolutionNamed(resolution);
    const parsed = definition.sizing.safeParse(sizing);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      throw new CatalogError(`sizing of ${resolution} is not valid: ${problems.join("; ")}`);
    }
    return [name as Name, definition.meter(parsed.data)] as const;
  });

  const result: EnvironmentEstimate<Name> = { intents: {} as Record<Name, Estimate>, total: emptyEstimate() };
  for (const [name] of meters) result.intents[name] = emptyEstimate();

  for (const [figure, freeTier] of figures) {
    for (const [scenarioName, scenario] of scenarioEntries) {
      const pool = freshPool(pricing, freeTier);
      let total = 0;
      for (const [name, meter] of meters) {
        const amount = priceLineItems(meter(usage, scenario, pricing), pool);
        result.intents[name]![figure][scenarioName] = roundToCents(amount);
        total += amount;
      }
      result.total[figure][scenarioName] = roundToCents(total);
    }
  }
  return result;
}

function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
