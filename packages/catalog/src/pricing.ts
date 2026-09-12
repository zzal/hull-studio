import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LineItem } from "./meters.js";

// The pricing snapshot is data, not code: a JSON file in the package covering
// only the SKUs the three v0 resolutions use, with the free tier rules beside
// the prices so a change in the tier's shape is a data change. A wrong price
// is fixed by editing the file, never a cost model.

const price = z.number().nonnegative();
const allowance = z.number().nonnegative();

// Monthly free tier allowances, account-wide: every intent of an environment
// draws from the same pool.
const freeTierAllowancesSchema = z.object({
  lambdaMillionRequests: allowance,
  lambdaGbSeconds: allowance,
  apiGatewayMillionRequests: allowance,
  rdsInstanceHours: allowance,
  rdsStorageGbMonths: allowance,
  applicationLoadBalancerHours: allowance,
  applicationLoadBalancerLcuHours: allowance,
});
export type FreeTierAllowances = z.infer<typeof freeTierAllowancesSchema>;
export type FreeTierAllowance = keyof FreeTierAllowances;

const pricingSnapshotSchema = z.object({
  provider: z.literal("aws"),
  region: z.string().min(1),
  currency: z.literal("USD"),
  source: z.string(),
  retrievedAt: z.string(),
  hoursPerMonth: z.number().positive(),
  lambda: z.object({ perMillionRequests: price, perGbSecond: price }),
  apiGateway: z.object({ http: z.object({ perMillionRequests: price }) }),
  rds: z.object({
    postgres: z.object({
      instanceHour: z.record(z.string(), price),
      storageGbMonth: z.object({ gp3: price }),
      multiAzFactor: z.number().positive(),
    }),
  }),
  secretsManager: z.object({ secretMonth: price }),
  fargate: z.object({ vcpuHour: price, gbHour: price }),
  applicationLoadBalancer: z.object({ hour: price, lcuHour: price }),
  freeTier: z.object({
    label: z.string().min(1),
    note: z.string(),
    rdsEligibleInstanceClasses: z.array(z.string()),
    monthly: freeTierAllowancesSchema,
  }),
});
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;

// Resolves from both `src/` and `dist/`.
const snapshotUrl = new URL("../pricing/aws.json", import.meta.url);

// The snapshot shipped with this catalog version.
export const pricing: PricingSnapshot = pricingSnapshotSchema.parse(JSON.parse(readFileSync(snapshotUrl, "utf8")));

// What is left of the free tier while an environment's line items are priced
// in order; undefined means the free tier is not applied.
export type AllowancePool = FreeTierAllowances | undefined;

export function freshPool(pricing: PricingSnapshot, freeTier: boolean): AllowancePool {
  return freeTier ? { ...pricing.freeTier.monthly } : undefined;
}

// Price line items, drawing each from the pool it names and leaving the pool
// smaller for the items priced after it.
export function priceLineItems(items: LineItem[], pool: AllowancePool): number {
  let amount = 0;
  for (const item of items) {
    let billed = item.quantity;
    if (pool && item.allowance) {
      const free = Math.min(item.quantity, pool[item.allowance]);
      pool[item.allowance] -= free;
      billed -= free;
    }
    amount += billed * item.unitPrice;
  }
  return amount;
}
