import type { SizingValue, UsageProfile } from "@hull/blueprint";
import { z } from "zod";

// Sizing derivation: a pure function of the usage profile per resolution.
// Every rule is a readable table so a wrong outcome is fixable by a pull
// request.

export type Sizing = Record<string, SizingValue>;

// Request volume bands. The low-end profile `hull init` writes (100,000
// requests a month) sits in the first band, which yields the plan's numbers:
// 512 MB / 10 s for Lambda, db.t4g.micro for RDS. Anything above the last
// threshold gets the heaviest band.
const requestBands = [
  { upToRequestsPerMonth: 5_000_000, lambdaMemoryMb: 512, rdsInstanceClass: "db.t4g.micro", fargateCpu: 256, fargateMemoryMb: 512, fargateDesiredCount: 1 },
  { upToRequestsPerMonth: 50_000_000, lambdaMemoryMb: 1024, rdsInstanceClass: "db.t4g.small", fargateCpu: 256, fargateMemoryMb: 512, fargateDesiredCount: 2 },
] as const;
const heaviestBand = { lambdaMemoryMb: 1024, rdsInstanceClass: "db.t4g.medium", fargateCpu: 512, fargateMemoryMb: 1024, fargateDesiredCount: 2 } as const;

function bandFor(usage: UsageProfile) {
  return requestBands.find((band) => usage.requestsPerMonth <= band.upToRequestsPerMonth) ?? heaviestBand;
}

// Message volume bands mirror the request bands. The low-end profile yields
// the milestone 2 plan's numbers: 60 s / 4 days for the queue, 512 MB / 30 s /
// batches of 10 / concurrency 2 for the worker. The queue's visibility
// timeout stays at least twice the worker's timeout in every band, as the
// event source mapping requires the first to cover the second.
const messageBands = [
  { upToMessagesPerMonth: 5_000_000, visibilityTimeoutSeconds: 60, retentionDays: 4, workerMemoryMb: 512, workerTimeoutSeconds: 30, batchSize: 10, maxConcurrency: 2, fargateCpu: 256, fargateMemoryMb: 512, fargateDesiredCount: 1 },
  { upToMessagesPerMonth: 50_000_000, visibilityTimeoutSeconds: 120, retentionDays: 7, workerMemoryMb: 1024, workerTimeoutSeconds: 60, batchSize: 10, maxConcurrency: 5, fargateCpu: 256, fargateMemoryMb: 512, fargateDesiredCount: 2 },
] as const;
const heaviestMessageBand = { visibilityTimeoutSeconds: 300, retentionDays: 14, workerMemoryMb: 1024, workerTimeoutSeconds: 120, batchSize: 10, maxConcurrency: 10, fargateCpu: 512, fargateMemoryMb: 1024, fargateDesiredCount: 2 } as const;

// An absent messagesPerMonth is zero: a milestone 1 blueprint has no queue.
export const messagesPerMonth = (usage: UsageProfile) => usage.messagesPerMonth ?? 0;

function messageBandFor(usage: UsageProfile) {
  return messageBands.find((band) => messagesPerMonth(usage) <= band.upToMessagesPerMonth) ?? heaviestMessageBand;
}

const lambdaTimeoutSeconds = 10;

// RDS storage is allocated, not used: round the profile's storage up to the
// next 10 GB with the gp3 minimum of 20 GB as the floor. Multi-AZ waits for
// the disaster recovery policy; v0 derives single-AZ.
const rdsStorageStepGb = 10;
const rdsMinimumStorageGb = 20;

export const lambdaSizingSchema = z.object({
  memoryMb: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
});
export type LambdaSizing = z.infer<typeof lambdaSizingSchema>;

export function deriveLambdaSizing(usage: UsageProfile): LambdaSizing {
  return { memoryMb: bandFor(usage).lambdaMemoryMb, timeoutSeconds: lambdaTimeoutSeconds };
}

export const fargateSizingSchema = z.object({
  cpu: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  desiredCount: z.number().int().nonnegative(),
});
export type FargateSizing = z.infer<typeof fargateSizingSchema>;

export function deriveFargateSizing(usage: UsageProfile): FargateSizing {
  const band = bandFor(usage);
  return { cpu: band.fargateCpu, memoryMb: band.fargateMemoryMb, desiredCount: band.fargateDesiredCount };
}

export const rdsSizingSchema = z.object({
  instanceClass: z.string().min(1),
  storageGb: z.number().int().positive(),
  multiAz: z.boolean(),
});
export type RdsSizing = z.infer<typeof rdsSizingSchema>;

export function deriveRdsSizing(usage: UsageProfile): RdsSizing {
  return {
    instanceClass: bandFor(usage).rdsInstanceClass,
    storageGb: Math.max(rdsMinimumStorageGb, Math.ceil(usage.storageGb / rdsStorageStepGb) * rdsStorageStepGb),
    multiAz: false,
  };
}

export const sqsSizingSchema = z.object({
  visibilityTimeoutSeconds: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
});
export type SqsSizing = z.infer<typeof sqsSizingSchema>;

export function deriveSqsSizing(usage: UsageProfile): SqsSizing {
  const band = messageBandFor(usage);
  return { visibilityTimeoutSeconds: band.visibilityTimeoutSeconds, retentionDays: band.retentionDays };
}

export const lambdaWorkerSizingSchema = z.object({
  memoryMb: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  // The event source mapping's floor is two.
  maxConcurrency: z.number().int().min(2),
});
export type LambdaWorkerSizing = z.infer<typeof lambdaWorkerSizingSchema>;

export function deriveLambdaWorkerSizing(usage: UsageProfile): LambdaWorkerSizing {
  const band = messageBandFor(usage);
  return { memoryMb: band.workerMemoryMb, timeoutSeconds: band.workerTimeoutSeconds, batchSize: band.batchSize, maxConcurrency: band.maxConcurrency };
}

export function deriveFargateWorkerSizing(usage: UsageProfile): FargateSizing {
  const band = messageBandFor(usage);
  return { cpu: band.fargateCpu, memoryMb: band.fargateMemoryMb, desiredCount: band.fargateDesiredCount };
}
