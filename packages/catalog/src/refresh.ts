import { z } from "zod";
import type { FreeTier, PricingSnapshot } from "./pricing-schema.js";

// The pricing refresh below the network: from the current offer files of the
// AWS Price List Bulk API for one region, the prices of exactly the SKUs the
// three v0 resolutions use. The free tier rules are verified by hand and
// live in the snapshot on disk; a refresh carries them over untouched. Run
// by scripts/refresh-pricing.ts; unit-tested on fixtures.

// The offer code of each price list file the resolutions draw from.
export const offerCodes = ["AWSLambda", "AmazonApiGateway", "AmazonRDS", "AWSSecretsManager", "AmazonECS", "AWSELB"] as const;
export type OfferCode = (typeof offerCodes)[number];

// The public offer file URL; no credentials needed. The host is fixed to
// us-east-1 whatever the region priced.
export const offerUrl = (offerCode: OfferCode, region: string) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${offerCode}/current/${region}/index.json`;

// The parts of an offer file the refresh reads, checked on the way in: the
// file is external data.
const priceDimensionSchema = z.object({ beginRange: z.string(), endRange: z.string(), unit: z.string(), pricePerUnit: z.object({ USD: z.string().optional() }) });
export const offerFileSchema = z.object({
  offerCode: z.string(),
  version: z.string(),
  publicationDate: z.string(),
  products: z.record(z.string(), z.object({ productFamily: z.string().optional(), attributes: z.record(z.string(), z.string()) })),
  terms: z.object({ OnDemand: z.record(z.string(), z.record(z.string(), z.object({ priceDimensions: z.record(z.string(), priceDimensionSchema) }))) }),
});
export type OfferFile = z.infer<typeof offerFileSchema>;
export type OfferFiles = Record<OfferCode, OfferFile>;

type Attributes = Record<string, string>;
// One SKU as the resolutions use it: which file, which product family, and
// what tells it apart.
type Lookup = { offerCode: OfferCode; label: string; family: string; match: (attributes: Attributes) => boolean };

// A usage type is prefixed with a region code outside us-east-1 (and in some
// files inside it: USE1-); variants carry a word before the name instead.
const usageType = (name: string) => {
  const pattern = new RegExp(`^(?:[A-Z]{2,4}\\d-)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return (attributes: Attributes) => pattern.test(attributes.usagetype ?? "");
};

type Deployment = "Single-AZ" | "Multi-AZ";
const deployments: Record<Deployment, "singleAz" | "multiAz"> = { "Single-AZ": "singleAz", "Multi-AZ": "multiAz" };

export const rdsInstanceClasses = ["db.t4g.micro", "db.t4g.small", "db.t4g.medium"] as const;

const lookups = {
  lambdaRequest: { offerCode: "AWSLambda", label: "Lambda request", family: "Serverless", match: (a) => a.group === "AWS-Lambda-Requests" && usageType("Request")(a) },
  lambdaGbSecond: { offerCode: "AWSLambda", label: "Lambda GB-second", family: "Serverless", match: (a) => a.group === "AWS-Lambda-Duration" && usageType("Lambda-GB-Second")(a) },
  apiGatewayHttpRequest: { offerCode: "AmazonApiGateway", label: "API Gateway HTTP API request", family: "API Calls", match: usageType("ApiGatewayHttpRequest") },
  secret: { offerCode: "AWSSecretsManager", label: "Secrets Manager secret month", family: "Secret", match: usageType("AWSSecretsManager-Secrets") },
  fargateVcpuHour: { offerCode: "AmazonECS", label: "Fargate Linux x86 vCPU hour", family: "Compute", match: usageType("Fargate-vCPU-Hours:perCPU") },
  fargateGbHour: { offerCode: "AmazonECS", label: "Fargate Linux x86 GB hour", family: "Compute", match: usageType("Fargate-GB-Hours") },
  albHour: { offerCode: "AWSELB", label: "Application Load Balancer hour", family: "Load Balancer-Application", match: usageType("LoadBalancerUsage") },
  albLcuHour: { offerCode: "AWSELB", label: "Application Load Balancer capacity unit hour", family: "Load Balancer-Application", match: usageType("LCUUsage") },
} satisfies Record<string, Lookup>;

const rdsInstance = (instanceType: string, deployment: Deployment): Lookup => ({
  offerCode: "AmazonRDS",
  label: `RDS PostgreSQL ${instanceType} ${deployment} instance hour`,
  family: "Database Instance",
  match: (a) => a.databaseEngine === "PostgreSQL" && a.instanceType === instanceType && a.deploymentOption === deployment,
});
const rdsStorage = (deployment: Deployment): Lookup => ({
  offerCode: "AmazonRDS",
  label: `RDS PostgreSQL ${deployment} gp3 storage GB-month`,
  family: "Database Storage",
  match: (a) => a.databaseEngine === "PostgreSQL" && a.volumeType === "General Purpose-GP3" && a.deploymentOption === deployment,
});

// Every SKU above, plus one instance hour and one storage GB-month per
// deployment: the number a refresh must read, and does, or throws.
export const skuCount = Object.keys(lookups).length + Object.keys(deployments).length * (rdsInstanceClasses.length + 1);

const million = 1_000_000;
const hoursPerMonth = 730;

export function refreshPrices(offers: OfferFiles, region: string, freeTier: FreeTier): PricingSnapshot {
  const price = (lookup: Lookup) => firstTierPrice(offers[lookup.offerCode], region, lookup);
  const byDeployment = (lookup: (deployment: Deployment) => Lookup) =>
    Object.fromEntries(Object.entries(deployments).map(([deployment, key]) => [key, price(lookup(deployment as Deployment))])) as Record<"singleAz" | "multiAz", number>;

  return {
    provider: "aws",
    region,
    currency: "USD",
    source: `AWS Price List Bulk API, current offer files for ${region}: ${offerCodes.map((offerCode) => `${offerCode} ${offers[offerCode].version}`).join(", ")}`,
    publishedAt: offerCodes.map((offerCode) => offers[offerCode].publicationDate).reduce((newest, date) => (date > newest ? date : newest)),
    hoursPerMonth,
    lambda: { perMillionRequests: round(price(lookups.lambdaRequest) * million), perGbSecond: price(lookups.lambdaGbSecond) },
    apiGateway: { http: { perMillionRequests: round(price(lookups.apiGatewayHttpRequest) * million) } },
    rds: {
      postgres: {
        instanceHour: Object.fromEntries(rdsInstanceClasses.map((instanceClass) => [instanceClass, byDeployment((deployment) => rdsInstance(instanceClass, deployment))])),
        storageGbMonth: { gp3: byDeployment(rdsStorage) },
      },
    },
    secretsManager: { secretMonth: price(lookups.secret) },
    fargate: { vcpuHour: price(lookups.fargateVcpuHour), gbHour: price(lookups.fargateGbHour) },
    applicationLoadBalancer: { hour: price(lookups.albHour), lcuHour: price(lookups.albLcuHour) },
    freeTier: structuredClone(freeTier),
  };
}

// The on-demand price of the one SKU matching the lookup in the region, at
// the first tier (from zero usage): the volume tiers start far above what
// an estimate here reaches.
function firstTierPrice(offer: OfferFile, region: string, { label, family, match }: Lookup): number {
  const matching = Object.entries(offer.products).filter(
    ([, product]) => product.attributes.regionCode === region && product.productFamily === family && match(product.attributes),
  );
  if (matching.length !== 1) {
    const subject = matching.length === 0 ? "no SKU" : `${matching.length} SKUs`;
    const verb = matching.length === 0 ? "matches" : "match";
    throw new Error(`${subject} in ${offer.offerCode} for ${region} ${verb} the ${label}`);
  }
  const [sku] = matching[0]!;
  const dimensions = Object.values(offer.terms.OnDemand[sku] ?? {}).flatMap((term) => Object.values(term.priceDimensions));
  const first = dimensions.find((dimension) => Number(dimension.beginRange) === 0);
  const usd = first?.pricePerUnit.USD;
  if (usd === undefined) throw new Error(`the ${label} (${sku} in ${offer.offerCode}) has no on-demand USD price from zero usage`);
  return Number(usd);
}

// Products of a price and a count come out with floating-point dust.
const round = (value: number) => Math.round(value * 1e10) / 1e10;
