import { z } from "zod";

// The shape of the pricing snapshot, apart from the file that holds it, so
// the refresh script can read one block of the file on disk without parsing
// the whole of it.

const price = z.number().nonnegative();
const byDeployment = z.object({ singleAz: price, multiAz: price });
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
  sqsMillionRequests: allowance,
});
export type FreeTierAllowances = z.infer<typeof freeTierAllowancesSchema>;
export type FreeTierAllowance = keyof FreeTierAllowances;

export const freeTierSchema = z.object({
  label: z.string().min(1),
  note: z.string(),
  verifiedAt: z.string(),
  sources: z.array(z.url()),
  rdsEligibleInstanceClasses: z.array(z.string()),
  monthly: freeTierAllowancesSchema,
});
export type FreeTier = z.infer<typeof freeTierSchema>;

export const pricingSnapshotSchema = z.object({
  provider: z.literal("aws"),
  region: z.string().min(1),
  currency: z.literal("USD"),
  source: z.string(),
  // The newest publication date among the offer files read, so a refresh
  // on the same files writes the same bytes.
  publishedAt: z.string(),
  hoursPerMonth: z.number().positive(),
  lambda: z.object({ perMillionRequests: price, perGbSecond: price }),
  apiGateway: z.object({ http: z.object({ perMillionRequests: price }) }),
  rds: z.object({
    postgres: z.object({
      // Multi-AZ is priced on its own SKU, not as a multiple of Single-AZ.
      instanceHour: z.record(z.string(), byDeployment),
      storageGbMonth: z.object({ gp3: byDeployment }),
    }),
  }),
  secretsManager: z.object({ secretMonth: price }),
  sqs: z.object({ perMillionRequests: price }),
  fargate: z.object({ vcpuHour: price, gbHour: price }),
  applicationLoadBalancer: z.object({ hour: price, lcuHour: price }),
  // Verified by hand against AWS's published rules (the package README
  // holds the write-up); the refresh script never touches this block.
  freeTier: freeTierSchema,
});
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
