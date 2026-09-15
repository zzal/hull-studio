import type { IntentKind, Provider, UsageProfile, Vocabulary } from "@hull/blueprint";
import type { z } from "zod";
import { CatalogError, notAmong } from "./errors.js";
import {
  fargateLoadBalancerMeter,
  fargateWorkerMeter,
  lambdaApiGatewayMeter,
  lambdaWorkerMeter,
  rdsPostgresMeter,
  resources,
  scenarios,
  sqsStandardMeter,
  type LineItem,
  type Meter,
  type MeterContext,
  type ScenarioName,
} from "./meters.js";
import { freshPool, priceLineItems, type PricingSnapshot } from "./pricing.js";
import {
  deriveFargateSizing,
  deriveFargateWorkerSizing,
  deriveLambdaSizing,
  deriveLambdaWorkerSizing,
  deriveRdsSizing,
  deriveSqsSizing,
  fargateSizingSchema,
  lambdaSizingSchema,
  lambdaWorkerSizingSchema,
  rdsSizingSchema,
  sqsSizingSchema,
  type Sizing,
} from "./sizing.js";

// Catalog v1: the four intent kinds and six resolutions of the milestone 2
// plan. One table per resolution binds its provider, kind, sizing parameters,
// derivation, cost model and the resources it implies, so nothing else in the
// package switches on the resolution name. The two Fargate resolutions exist
// so the recommendations have something real to compare; they are not
// deployable in this version.

type Resolution<S extends z.ZodObject> = {
  provider: Provider;
  kind: IntentKind;
  deployable: boolean;
  sizing: S;
  derive: (usage: UsageProfile) => z.infer<S>;
  meter: (sizing: z.infer<S>) => Meter;
  // The resources this resolution implies, in the provider's words; every
  // line item the meter produces names one of them.
  resources: readonly string[];
};

function resolution<S extends z.ZodObject>(definition: Resolution<S>): Resolution<S> {
  return definition;
}

const resolutions = {
  "lambda-api-gateway": resolution({
    provider: "aws",
    kind: "http-api",
    deployable: true,
    sizing: lambdaSizingSchema,
    derive: deriveLambdaSizing,
    meter: lambdaApiGatewayMeter,
    resources: resources["lambda-api-gateway"],
  }),
  "fargate-load-balancer": resolution({
    provider: "aws",
    kind: "http-api",
    deployable: false,
    sizing: fargateSizingSchema,
    derive: deriveFargateSizing,
    meter: fargateLoadBalancerMeter,
    resources: resources["fargate-load-balancer"],
  }),
  "rds-postgres": resolution({
    provider: "aws",
    kind: "relational-database",
    deployable: true,
    sizing: rdsSizingSchema,
    derive: deriveRdsSizing,
    meter: rdsPostgresMeter,
    resources: resources["rds-postgres"],
  }),
  "sqs-standard": resolution({
    provider: "aws",
    kind: "queue",
    deployable: true,
    sizing: sqsSizingSchema,
    derive: deriveSqsSizing,
    meter: sqsStandardMeter,
    resources: resources["sqs-standard"],
  }),
  "lambda-worker": resolution({
    provider: "aws",
    kind: "background-worker",
    deployable: true,
    sizing: lambdaWorkerSizingSchema,
    derive: deriveLambdaWorkerSizing,
    meter: lambdaWorkerMeter,
    resources: resources["lambda-worker"],
  }),
  "fargate-worker": resolution({
    provider: "aws",
    kind: "background-worker",
    deployable: false,
    sizing: fargateSizingSchema,
    derive: deriveFargateWorkerSizing,
    meter: fargateWorkerMeter,
    resources: resources["fargate-worker"],
  }),
};

// The roles each kind accepts on a link to it. A tier accepts none: a link
// never targets a tier.
const kinds: Vocabulary["kinds"] = {
  "http-api": { roles: [] },
  "relational-database": { roles: ["read-write"] },
  queue: { roles: ["produce", "consume"] },
  "background-worker": { roles: [] },
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

// What the studio shows about a resolution before any estimate: whether this
// version deploys it and the resources it implies.
export type ResolutionFacts = { resolution: string; kind: IntentKind; deployable: boolean; resources: readonly string[] };

export function resolutionFacts(name: string): ResolutionFacts {
  const { kind, deployable, resources } = resolutionNamed(name);
  return { resolution: name, kind, deployable, resources };
}

// Every candidate resolution of a kind on a provider, in catalog order.
export function candidatesOfKind(kind: IntentKind, provider: Provider): ResolutionFacts[] {
  return Object.entries(resolutions)
    .filter(([, definition]) => definition.kind === kind && definition.provider === provider)
    .map(([name]) => resolutionFacts(name));
}

// The kind of a resolution and every candidate of that kind on the same
// provider, each at its derived sizing for the profile, in catalog order.
export function candidatesOf(resolution: string, usage: UsageProfile): { kind: IntentKind; candidates: SizedIntent[] } {
  const { kind, provider } = resolutionNamed(resolution);
  const candidates = candidatesOfKind(kind, provider).map(({ resolution: name }) => ({ resolution: name, sizing: deriveSizing(name, usage) }));
  return { kind, candidates };
}

export type MonthlyRange = Record<ScenarioName, number>;
export type Estimate = { withoutFreeTier: MonthlyRange; withFreeTier: MonthlyRange };

// An intent as the estimate needs it: its resolution, its sizing for the
// environment, and its links, which the meter of a linked intent may read.
export type SizedIntent = { resolution: string; sizing: Sizing; links?: readonly { to: string; role: string }[] };

// The estimate of one resource a resolution implies; a resource with no
// line item shows as no charge.
export type ResourceEstimate = { resource: string } & Estimate;

export type IntentEstimate = Estimate & { resources: ResourceEstimate[] };

export type EnvironmentEstimate<Name extends string = string> = {
  intents: Record<Name, IntentEstimate>;
  total: Estimate;
};

const figures = [
  ["withoutFreeTier", false],
  ["withFreeTier", true],
] as const;
const scenarioEntries = Object.entries(scenarios) as [ScenarioName, (typeof scenarios)[ScenarioName]][];

const emptyRange = (): MonthlyRange => ({ low: 0, expected: 0, high: 0 });
const emptyEstimate = (): Estimate => ({ withoutFreeTier: emptyRange(), withFreeTier: emptyRange() });

// The monthly estimate of every intent, of each resource it implies, and of
// the environment, as low / expected / high, with and without the free tier.
// Intents draw from one free tier pool in the order given, so the total never
// counts an allowance twice.
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
    const context: MeterContext = { name, intents };
    return [name as Name, definition.resources, definition.meter(parsed.data), context] as const;
  });

  const result: EnvironmentEstimate<Name> = { intents: {} as Record<Name, IntentEstimate>, total: emptyEstimate() };
  for (const [name, resourceNames] of meters) {
    result.intents[name] = { ...emptyEstimate(), resources: resourceNames.map((resource) => ({ resource, ...emptyEstimate() })) };
  }

  for (const [figure, freeTier] of figures) {
    for (const [scenarioName, scenario] of scenarioEntries) {
      const pool = freshPool(pricing, freeTier);
      let total = 0;
      for (const [name, resourceNames, meter, context] of meters) {
        const items = meter(usage, scenario, pricing, context);
        const unknown = items.find((item) => !resourceNames.includes(item.resource));
        if (unknown) throw new Error(`the cost model of ${context.intents[name]!.resolution} bills "${unknown.resource}", which it does not declare as a resource`);
        // Priced in line item order against the one pool, then summed per
        // resource: the resources' figures add up to the intent's exactly.
        const byResource = priceByResource(items, pool);
        let amount = 0;
        for (const resourceEstimate of result.intents[name]!.resources) {
          const resourceAmount = byResource.get(resourceEstimate.resource) ?? 0;
          resourceEstimate[figure][scenarioName] = roundToCents(resourceAmount);
          amount += resourceAmount;
        }
        result.intents[name]![figure][scenarioName] = roundToCents(amount);
        total += amount;
      }
      result.total[figure][scenarioName] = roundToCents(total);
    }
  }
  return result;
}

function priceByResource(items: LineItem[], pool: ReturnType<typeof freshPool>): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const item of items) {
    amounts.set(item.resource, (amounts.get(item.resource) ?? 0) + priceLineItems([item], pool));
  }
  return amounts;
}

function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
