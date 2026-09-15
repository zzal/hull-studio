import type { UsageProfile } from "@hull/blueprint";
import { CatalogError } from "./errors.js";
import type { FreeTierAllowance, PricingSnapshot } from "./pricing.js";
import { messagesPerMonth, type FargateSizing, type LambdaSizing, type LambdaWorkerSizing, type RdsSizing, type SqsSizing } from "./sizing.js";

// Cost models as usage meters: given a sized resolution, a usage profile and a
// scenario, each returns the metered quantities it would bill, priced from the
// snapshot. Pricing them, with or without the account-wide free tier, happens
// once for the whole environment (pricing.ts), never per intent. Every line
// item names the resource it is billed on, one of the resources the
// resolution declares, so the estimate can be explained resource by resource.

export type LineItem = {
  // The resource of the resolution this quantity is billed on.
  resource: string;
  quantity: number;
  unitPrice: number;
  // The free tier allowance this quantity draws from, if any.
  allowance?: FreeTierAllowance;
};

// The three figures of an estimate are three scenarios over the usage profile.
// Provisioned resources (an RDS instance, a Fargate task) cost the same in
// every scenario; only what scales with the load (requests, messages) moves,
// by the load factor.
export const scenarios = {
  low: { loadFactor: 0.5, lambdaDurationMs: 50 },
  expected: { loadFactor: 1, lambdaDurationMs: 100 },
  high: { loadFactor: 2, lambdaDurationMs: 300 },
} as const;
export type Scenario = (typeof scenarios)[keyof typeof scenarios];
export type ScenarioName = keyof typeof scenarios;

// What a meter may need to know about the other intents of the environment:
// a queue's requests depend on how its consumer batches them.
export type MeterContext = {
  // The intent being metered.
  name: string;
  intents: Record<string, { resolution: string; sizing: Record<string, unknown>; links?: readonly { to: string; role: string }[] }>;
};

export type Meter = (usage: UsageProfile, scenario: Scenario, pricing: PricingSnapshot, context: MeterContext) => LineItem[];

const million = 1_000_000;
const secondsPerHour = 3600;

// One Application Load Balancer capacity unit covers 25 new connections a
// second; at API traffic that is the dimension that fills first.
const albNewConnectionsPerSecondPerLcu = 25;

// The resources each resolution implies, in the provider's words (a
// resolution is provider-specific by definition). The compiler's program test
// checks these names against the Pulumi types the program declares, so the
// list the studio shows never differs from what deploys.
export const resources = {
  "lambda-api-gateway": ["Lambda function", "log group", "execution role", "security group", "HTTP API"],
  "fargate-load-balancer": ["Fargate tasks", "Application Load Balancer"],
  "rds-postgres": ["RDS instance", "gp3 storage", "security group", "managed master password secret"],
  "sqs-standard": ["SQS queue", "dead-letter queue"],
  "lambda-worker": ["Lambda function", "log group", "execution role", "event source mapping"],
  "fargate-worker": ["Fargate tasks"],
} as const satisfies Record<string, readonly string[]>;

export function lambdaApiGatewayMeter(sizing: LambdaSizing): Meter {
  return (usage, scenario, pricing) => {
    const requests = usage.requestsPerMonth * scenario.loadFactor;
    const gbSeconds = requests * (scenario.lambdaDurationMs / 1000) * (sizing.memoryMb / 1024);
    return [
      { resource: "Lambda function", quantity: requests / million, unitPrice: pricing.lambda.perMillionRequests, allowance: "lambdaMillionRequests" },
      { resource: "Lambda function", quantity: gbSeconds, unitPrice: pricing.lambda.perGbSecond, allowance: "lambdaGbSeconds" },
      { resource: "HTTP API", quantity: requests / million, unitPrice: pricing.apiGateway.http.perMillionRequests, allowance: "apiGatewayMillionRequests" },
    ];
  };
}

export function rdsPostgresMeter(sizing: RdsSizing): Meter {
  return (_usage, _scenario, pricing) => {
    const rds = pricing.rds.postgres;
    const instanceHour = rds.instanceHour[sizing.instanceClass];
    if (instanceHour === undefined) {
      throw new CatalogError(
        `no price in the ${pricing.provider} ${pricing.region} snapshot for RDS instance class "${sizing.instanceClass}"; priced classes are ${Object.keys(rds.instanceHour).join(", ")}`,
      );
    }
    const deployment = sizing.multiAz ? "multiAz" : "singleAz";
    // A free tier allowance, when one exists, covers one single-AZ instance of
    // an eligible class and its storage; anything else is billed in full.
    const eligible = !sizing.multiAz && pricing.freeTier.rdsEligibleInstanceClasses.includes(sizing.instanceClass);
    return [
      { resource: "RDS instance", quantity: pricing.hoursPerMonth, unitPrice: instanceHour[deployment], ...(eligible && { allowance: "rdsInstanceHours" }) },
      { resource: "gp3 storage", quantity: sizing.storageGb, unitPrice: rds.storageGbMonth.gp3[deployment], ...(eligible && { allowance: "rdsStorageGbMonths" }) },
      // The AWS-managed master password lives in one Secrets Manager secret.
      { resource: "managed master password secret", quantity: 1, unitPrice: pricing.secretsManager.secretMonth },
    ];
  };
}

const fargateTaskHour = (sizing: FargateSizing, pricing: PricingSnapshot) =>
  (sizing.cpu / 1024) * pricing.fargate.vcpuHour + (sizing.memoryMb / 1024) * pricing.fargate.gbHour;

export function fargateLoadBalancerMeter(sizing: FargateSizing): Meter {
  return (usage, scenario, pricing) => {
    const hours = pricing.hoursPerMonth;
    const requests = usage.requestsPerMonth * scenario.loadFactor;
    const requestsPerSecond = requests / (hours * secondsPerHour);
    const lcuHours = (requestsPerSecond / albNewConnectionsPerSecondPerLcu) * hours;
    return [
      { resource: "Fargate tasks", quantity: sizing.desiredCount * hours, unitPrice: fargateTaskHour(sizing, pricing) },
      { resource: "Application Load Balancer", quantity: hours, unitPrice: pricing.applicationLoadBalancer.hour, allowance: "applicationLoadBalancerHours" },
      { resource: "Application Load Balancer", quantity: lcuHours, unitPrice: pricing.applicationLoadBalancer.lcuHour, allowance: "applicationLoadBalancerLcuHours" },
    ];
  };
}

// The batch size of the tier consuming the queue named, or 1 when nothing
// consumes it: every message is then received on its own.
function consumerBatchSize(queue: string, context: MeterContext): number {
  for (const intent of Object.values(context.intents)) {
    if (!intent.links?.some((link) => link.to === queue && link.role === "consume")) continue;
    const batchSize = intent.sizing.batchSize;
    if (typeof batchSize === "number" && batchSize > 0) return batchSize;
  }
  return 1;
}

// Three SQS requests per message: the send, the receive (one per batch of
// the consumer's batch size) and the delete. The dead-letter queue idles.
export function sqsStandardMeter(_sizing: SqsSizing): Meter {
  return (usage, scenario, pricing, context) => {
    const messages = messagesPerMonth(usage) * scenario.loadFactor;
    const requests = messages + messages / consumerBatchSize(context.name, context) + messages;
    return [{ resource: "SQS queue", quantity: requests / million, unitPrice: pricing.sqs.perMillionRequests, allowance: "sqsMillionRequests" }];
  };
}

// Whether the tier being metered consumes a queue; a worker that consumes
// nothing yet is invoked by nothing.
function consumesQueue(context: MeterContext): boolean {
  return context.intents[context.name]?.links?.some((link) => link.role === "consume") ?? false;
}

// One invocation per batch, and the duration of handling each message.
export function lambdaWorkerMeter(sizing: LambdaWorkerSizing): Meter {
  return (usage, scenario, pricing, context) => {
    const messages = consumesQueue(context) ? messagesPerMonth(usage) * scenario.loadFactor : 0;
    const invocations = messages / sizing.batchSize;
    const gbSeconds = messages * (scenario.lambdaDurationMs / 1000) * (sizing.memoryMb / 1024);
    return [
      { resource: "Lambda function", quantity: invocations / million, unitPrice: pricing.lambda.perMillionRequests, allowance: "lambdaMillionRequests" },
      { resource: "Lambda function", quantity: gbSeconds, unitPrice: pricing.lambda.perGbSecond, allowance: "lambdaGbSeconds" },
    ];
  };
}

// Always-on tasks polling the queue; nothing else is billed.
export function fargateWorkerMeter(sizing: FargateSizing): Meter {
  return (_usage, _scenario, pricing) => [
    { resource: "Fargate tasks", quantity: sizing.desiredCount * pricing.hoursPerMonth, unitPrice: fargateTaskHour(sizing, pricing) },
  ];
}
