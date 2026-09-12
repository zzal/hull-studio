import type { UsageProfile } from "@hull/blueprint";
import { CatalogError } from "./errors.js";
import type { FreeTierAllowance, PricingSnapshot } from "./pricing.js";
import type { FargateSizing, LambdaSizing, RdsSizing } from "./sizing.js";

// Cost models as usage meters: given a sized resolution, a usage profile and a
// scenario, each returns the metered quantities it would bill, priced from the
// snapshot. Pricing them, with or without the account-wide free tier, happens
// once for the whole environment (pricing.ts), never per intent.

export type LineItem = {
  quantity: number;
  unitPrice: number;
  // The free tier allowance this quantity draws from, if any.
  allowance?: FreeTierAllowance;
};

// The three figures of an estimate are three scenarios over the usage profile.
// Provisioned resources (an RDS instance, a Fargate task) cost the same in
// every scenario; only what scales with requests moves.
export const scenarios = {
  low: { requestsFactor: 0.5, lambdaDurationMs: 50 },
  expected: { requestsFactor: 1, lambdaDurationMs: 100 },
  high: { requestsFactor: 2, lambdaDurationMs: 300 },
} as const;
export type Scenario = (typeof scenarios)[keyof typeof scenarios];
export type ScenarioName = keyof typeof scenarios;

export type Meter = (usage: UsageProfile, scenario: Scenario, pricing: PricingSnapshot) => LineItem[];

const million = 1_000_000;
const secondsPerHour = 3600;

// One Application Load Balancer capacity unit covers 25 new connections a
// second; at API traffic that is the dimension that fills first.
const albNewConnectionsPerSecondPerLcu = 25;

export function lambdaApiGatewayMeter(sizing: LambdaSizing): Meter {
  return (usage, scenario, pricing) => {
    const requests = usage.requestsPerMonth * scenario.requestsFactor;
    const gbSeconds = requests * (scenario.lambdaDurationMs / 1000) * (sizing.memoryMb / 1024);
    return [
      { quantity: requests / million, unitPrice: pricing.lambda.perMillionRequests, allowance: "lambdaMillionRequests" },
      { quantity: gbSeconds, unitPrice: pricing.lambda.perGbSecond, allowance: "lambdaGbSeconds" },
      { quantity: requests / million, unitPrice: pricing.apiGateway.http.perMillionRequests, allowance: "apiGatewayMillionRequests" },
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
    const azFactor = sizing.multiAz ? rds.multiAzFactor : 1;
    // The free tier covers one single-AZ instance of an eligible class and its
    // storage; anything else is billed in full.
    const eligible = !sizing.multiAz && pricing.freeTier.rdsEligibleInstanceClasses.includes(sizing.instanceClass);
    return [
      { quantity: pricing.hoursPerMonth, unitPrice: instanceHour * azFactor, ...(eligible && { allowance: "rdsInstanceHours" }) },
      { quantity: sizing.storageGb, unitPrice: rds.storageGbMonth.gp3 * azFactor, ...(eligible && { allowance: "rdsStorageGbMonths" }) },
      // The AWS-managed master password lives in one Secrets Manager secret.
      { quantity: 1, unitPrice: pricing.secretsManager.secretMonth },
    ];
  };
}

export function fargateLoadBalancerMeter(sizing: FargateSizing): Meter {
  return (usage, scenario, pricing) => {
    const hours = pricing.hoursPerMonth;
    const taskHour = (sizing.cpu / 1024) * pricing.fargate.vcpuHour + (sizing.memoryMb / 1024) * pricing.fargate.gbHour;
    const requests = usage.requestsPerMonth * scenario.requestsFactor;
    const requestsPerSecond = requests / (hours * secondsPerHour);
    const lcuHours = (requestsPerSecond / albNewConnectionsPerSecondPerLcu) * hours;
    return [
      { quantity: sizing.desiredCount * hours, unitPrice: taskHour },
      { quantity: hours, unitPrice: pricing.applicationLoadBalancer.hour, allowance: "applicationLoadBalancerHours" },
      { quantity: lcuHours, unitPrice: pricing.applicationLoadBalancer.lcuHour, allowance: "applicationLoadBalancerLcuHours" },
    ];
  };
}
