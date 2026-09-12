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
