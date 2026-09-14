import { readFileSync } from "node:fs";
import type { LineItem } from "./meters.js";
import { pricingSnapshotSchema, type FreeTierAllowances, type PricingSnapshot } from "./pricing-schema.js";

export type { FreeTierAllowance, FreeTierAllowances, PricingSnapshot } from "./pricing-schema.js";

// The pricing snapshot is data, not code: a JSON file in the package covering
// only the SKUs the three v0 resolutions use, with the free tier rules beside
// the prices so a change in the tier's shape is a data change. A wrong price
// is fixed by editing the file, never a cost model.

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
