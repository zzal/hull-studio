import { describe, expect, it } from "vitest";
import type { ErrorResponse, EstimateResponse } from "./index.js";
import { demoBlueprint, get, sampleBlueprint } from "./testing.js";

// GET /estimate?environment=<name>: the blueprint merged for that environment
// (usage profile, derived sizing with overrides marked), the monthly figures per
// intent, per resource the intent implies, and in total, with and without
// free tier. The resources' figures add up to the intent's, so the estimate
// is explained, not announced.
//
// Expected figures are worked by hand from the pricing snapshot in
// packages/catalog/pricing/aws.json (us-east-1, 730 hours a month) and the
// three scenarios of the cost model: low = half the load at 50 ms per Lambda
// invocation, expected = the profile at 100 ms, high = double at 300 ms.

const noCharge = { withoutFreeTier: { low: 0, expected: 0, high: 0 }, withFreeTier: { low: 0, expected: 0, high: 0 } };

const estimate = (text: string, environment: string) =>
  get<EstimateResponse>(text, `/estimate?environment=${environment}`);

describe("GET /estimate for the sample blueprint's dev environment", () => {
  // 100,000 requests a month, 1 GB stored.
  //
  // api on lambda-api-gateway, derived 512 MB / 10 s:
  //   expected: Lambda function: requests 0.1M x $0.20 = $0.02 plus
  //             duration 100,000 x 0.1 s x 0.5 GB = 5,000 GB-s x
  //             $0.0000166667 = $0.0833                                  -> $0.10
  //             HTTP API: 0.1M x $1.00                                   -> $0.10
  //             together                                                 -> $0.20
  //   low:      50,000 requests, 1,250 GB-s: function $0.01 + $0.0208
  //             = $0.03, HTTP API $0.05                                  -> $0.08
  //   high:     200,000 requests, 30,000 GB-s: function $0.04 + $0.50
  //             = $0.54, HTTP API $0.20                                  -> $0.74
  //   with free tier: Lambda's always-free 1M requests and 400,000 GB-s
  //   cover the function; the HTTP API has no always-free allowance      -> $0.10
  //   (low $0.05, high $0.20)
  //   the log group, the execution role and the security group bill nothing
  //
  // db on rds-postgres, derived db.t4g.micro / 20 GB / single-AZ:
  //   RDS instance 730 h x $0.016 = $11.68, gp3 storage 20 GB x $0.115 =
  //   $2.30, managed master password secret $0.40, the security group
  //   nothing; the same at every load                                    -> $14.38
  //   with free tier: RDS has no always-free allowance                    -> $14.38
  it("derives the low-end sizing and estimates each intent and the total", async () => {
    const { status, body } = await estimate(sampleBlueprint, "dev");

    expect(status).toBe(200);
    expect(body).toEqual({
      environment: "dev",
      usage: { requestsPerMonth: 100000, storageGb: 1 },
      freeTierLabel: "always-free allowances only",
      intents: {
        api: {
          resolution: "lambda-api-gateway",
          deployable: true,
          sizing: {
            memoryMb: { value: 512, source: "derived" },
            timeoutSeconds: { value: 10, source: "derived" },
          },
          withoutFreeTier: { low: 0.08, expected: 0.2, high: 0.74 },
          withFreeTier: { low: 0.05, expected: 0.1, high: 0.2 },
          resources: [
            {
              resource: "Lambda function",
              withoutFreeTier: { low: 0.03, expected: 0.1, high: 0.54 },
              withFreeTier: { low: 0, expected: 0, high: 0 },
            },
            { resource: "log group", ...noCharge },
            { resource: "execution role", ...noCharge },
            { resource: "security group", ...noCharge },
            {
              resource: "HTTP API",
              withoutFreeTier: { low: 0.05, expected: 0.1, high: 0.2 },
              withFreeTier: { low: 0.05, expected: 0.1, high: 0.2 },
            },
          ],
        },
        db: {
          resolution: "rds-postgres",
          deployable: true,
          sizing: {
            instanceClass: { value: "db.t4g.micro", source: "derived" },
            storageGb: { value: 20, source: "derived" },
            multiAz: { value: false, source: "derived" },
          },
          withoutFreeTier: { low: 14.38, expected: 14.38, high: 14.38 },
          withFreeTier: { low: 14.38, expected: 14.38, high: 14.38 },
          resources: [
            {
              resource: "RDS instance",
              withoutFreeTier: { low: 11.68, expected: 11.68, high: 11.68 },
              withFreeTier: { low: 11.68, expected: 11.68, high: 11.68 },
            },
            {
              resource: "gp3 storage",
              withoutFreeTier: { low: 2.3, expected: 2.3, high: 2.3 },
              withFreeTier: { low: 2.3, expected: 2.3, high: 2.3 },
            },
            { resource: "security group", ...noCharge },
            {
              resource: "managed master password secret",
              withoutFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
              withFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
            },
          ],
        },
      },
      total: {
        withoutFreeTier: { low: 14.46, expected: 14.58, high: 15.12 },
        withFreeTier: { low: 14.43, expected: 14.48, high: 14.58 },
      },
    });
  });
});

describe("GET /estimate for the sample blueprint's prod environment", () => {
  // 2,000,000 requests a month (the environment's usage profile over the
  // base), 1 GB stored (from the base), instanceClass pinned to db.t4g.small.
  //
  // api, still 512 MB / 10 s (under 5M requests):
  //   expected: 2M requests: function $0.40 + 100,000 GB-s $1.6667 =
  //             $2.07, HTTP API $2.00                                      -> $4.07
  //   low:      1M requests: function $0.20 + 25,000 GB-s $0.4167 =
  //             $0.62, HTTP API $1.00                                      -> $1.62
  //   high:     4M requests: function $0.80 + 600,000 GB-s $10.00 =
  //             $10.80, HTTP API $4.00                                     -> $14.80
  //   with free tier (1M requests and 400,000 GB-s free, the gateway not):
  //     expected: function 1M x $0.20 + 0 = $0.20, HTTP API 2M x $1.00     -> $2.20
  //     low: function within the allowances, HTTP API $1.00               -> $1.00
  //     high: function 3M x $0.20 + 200,000 GB-s x $0.0000166667 =
  //           $3.93, HTTP API 4M x $1.00                                   -> $7.93
  //
  // db pinned to db.t4g.small, derived 20 GB / single-AZ:
  //   instance 730 h x $0.032 = $23.36 + $2.30 storage + $0.40 secret      -> $26.06
  //   with free tier: nothing of RDS is always free                        -> $26.06
  it("applies the environment's usage profile and marks the pinned instance class as overridden", async () => {
    const { status, body } = await estimate(sampleBlueprint, "prod");

    expect(status).toBe(200);
    expect(body).toEqual({
      environment: "prod",
      usage: { requestsPerMonth: 2000000, storageGb: 1 },
      freeTierLabel: "always-free allowances only",
      intents: {
        api: {
          resolution: "lambda-api-gateway",
          deployable: true,
          sizing: {
            memoryMb: { value: 512, source: "derived" },
            timeoutSeconds: { value: 10, source: "derived" },
          },
          withoutFreeTier: { low: 1.62, expected: 4.07, high: 14.8 },
          withFreeTier: { low: 1, expected: 2.2, high: 7.93 },
          resources: [
            {
              resource: "Lambda function",
              withoutFreeTier: { low: 0.62, expected: 2.07, high: 10.8 },
              withFreeTier: { low: 0, expected: 0.2, high: 3.93 },
            },
            { resource: "log group", ...noCharge },
            { resource: "execution role", ...noCharge },
            { resource: "security group", ...noCharge },
            {
              resource: "HTTP API",
              withoutFreeTier: { low: 1, expected: 2, high: 4 },
              withFreeTier: { low: 1, expected: 2, high: 4 },
            },
          ],
        },
        db: {
          resolution: "rds-postgres",
          deployable: true,
          sizing: {
            instanceClass: { value: "db.t4g.small", source: "overridden" },
            storageGb: { value: 20, source: "derived" },
            multiAz: { value: false, source: "derived" },
          },
          withoutFreeTier: { low: 26.06, expected: 26.06, high: 26.06 },
          withFreeTier: { low: 26.06, expected: 26.06, high: 26.06 },
          resources: [
            {
              resource: "RDS instance",
              withoutFreeTier: { low: 23.36, expected: 23.36, high: 23.36 },
              withFreeTier: { low: 23.36, expected: 23.36, high: 23.36 },
            },
            {
              resource: "gp3 storage",
              withoutFreeTier: { low: 2.3, expected: 2.3, high: 2.3 },
              withFreeTier: { low: 2.3, expected: 2.3, high: 2.3 },
            },
            { resource: "security group", ...noCharge },
            {
              resource: "managed master password secret",
              withoutFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
              withFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
            },
          ],
        },
      },
      total: {
        withoutFreeTier: { low: 27.68, expected: 30.13, high: 40.86 },
        withFreeTier: { low: 27.06, expected: 28.26, high: 33.99 },
      },
    });
  });

  // A second HTTP API in prod, also at 2M requests. The free tier is one
  // pool for the account: api draws the 1M free requests first, admin gets
  // none of them and only the 300,000 GB-s left.
  //   admin with free tier, expected: 2M x $0.20 + 0 + 2M x $1.00          -> $2.40
  //   total with free tier, expected: $2.20 + $2.40 + $26.06               -> $30.66
  //   total without: $4.0667 + $4.0667 + $26.06                            -> $34.19
  it("draws every intent from one free tier pool so the total never counts an allowance twice", async () => {
    const twoApis = sampleBlueprint.replace(
      "  db:\n",
      "  admin:\n    kind: http-api\n    resolution: lambda-api-gateway\n    entry: src/admin.ts\n\n  db:\n",
    );

    const { body } = await estimate(twoApis, "prod");

    expect(body.intents.api?.withFreeTier.expected).toBe(2.2);
    expect(body.intents.admin?.withFreeTier.expected).toBe(2.4);
    expect(body.total.withFreeTier.expected).toBe(30.66);
    expect(body.total.withoutFreeTier.expected).toBe(34.19);
  });

  // Multi-AZ is priced on its own SKUs, not as a double: db.t4g.small is
  // $0.065 an hour, not 2 x $0.032; gp3 storage is $0.23 a GB-month.
  //   730 h x $0.065 = $47.45 + 20 GB x $0.23 = $4.60 + $0.40               -> $52.45
  it("prices the database at its Multi-AZ SKUs when multiAz is pinned", async () => {
    const multiAz = sampleBlueprint.replace("instanceClass: db.t4g.small", "instanceClass: db.t4g.small\n        multiAz: true");

    const { body } = await estimate(multiAz, "prod");

    expect(body.intents.db?.sizing.multiAz).toEqual({ value: true, source: "overridden" });
    expect(body.intents.db?.withoutFreeTier).toEqual({ low: 52.45, expected: 52.45, high: 52.45 });
    expect(body.intents.db?.withFreeTier).toEqual({ low: 52.45, expected: 52.45, high: 52.45 });
  });
});

describe("GET /estimate for an HTTP API on fargate-load-balancer", () => {
  // The dev profile (100,000 requests) with the api resolution switched.
  // Derived one task of 256 CPU units / 512 MB behind a load balancer.
  //   Fargate tasks: (0.25 vCPU x $0.04048 + 0.5 GB x $0.004445) x 730 h  -> $9.0100
  //   Application Load Balancer: 730 h x $0.0225 = $16.425, plus the
  //   capacity units: 100,000 requests / (3600 s x 25 connections per
  //   unit) = 1.11 LCU-hours x $0.008 = $0.0089                            -> $16.43
  //   expected $25.44; low (0.56 LCU-h) $25.44; high (2.22 LCU-h, the
  //   balancer $16.44) $25.45
  //   with free tier: nothing of Fargate or the load balancer is always
  //   free                                                                 -> $25.44
  //   not deployable in this version: the candidate is priced, not built
  it("estimates the task hours and the load balancer, none of it in the free tier", async () => {
    const fargate = sampleBlueprint.replace("resolution: lambda-api-gateway", "resolution: fargate-load-balancer");

    const { status, body } = await estimate(fargate, "dev");

    expect(status).toBe(200);
    expect(body.intents.api).toEqual({
      resolution: "fargate-load-balancer",
      deployable: false,
      sizing: {
        cpu: { value: 256, source: "derived" },
        memoryMb: { value: 512, source: "derived" },
        desiredCount: { value: 1, source: "derived" },
      },
      withoutFreeTier: { low: 25.44, expected: 25.44, high: 25.45 },
      withFreeTier: { low: 25.44, expected: 25.44, high: 25.45 },
      resources: [
        {
          resource: "Fargate tasks",
          withoutFreeTier: { low: 9.01, expected: 9.01, high: 9.01 },
          withFreeTier: { low: 9.01, expected: 9.01, high: 9.01 },
        },
        {
          resource: "Application Load Balancer",
          withoutFreeTier: { low: 16.43, expected: 16.43, high: 16.44 },
          withFreeTier: { low: 16.43, expected: 16.43, high: 16.44 },
        },
      ],
    });
    expect(body.total).toEqual({
      withoutFreeTier: { low: 39.82, expected: 39.82, high: 39.83 },
      withFreeTier: { low: 39.82, expected: 39.82, high: 39.83 },
    });
  });
});

describe("GET /estimate for the milestone 2 demo blueprint", () => {
  // dev: 100,000 requests, 100,000 messages, 1 GB. api and db as in the
  // sample's dev environment; the free tier pool is drawn in blueprint
  // order (api, jobs, worker, db).
  //
  // jobs on sqs-standard, derived 60 s / 4 days, consumed by worker in
  // batches of 10: three requests per message, the receive batched:
  //   expected: 100,000 sends + 10,000 receives + 100,000 deletes =
  //             0.21M x $0.40                                             -> $0.08
  //   low: 0.105M x $0.40 = $0.042 -> $0.04; high: 0.42M -> $0.168 -> $0.17
  //   with free tier: SQS's always-free million requests cover it         -> $0.00
  //   the dead-letter queue bills nothing
  //
  // worker on lambda-worker, derived 512 MB / 30 s / batches of 10 /
  // concurrency 2:
  //   expected: 10,000 invocations x $0.20/M = $0.002, duration 100,000
  //             messages x 0.1 s x 0.5 GB = 5,000 GB-s x $0.0000166667 =
  //             $0.0833                                                    -> $0.09
  //   low: 5,000 invocations $0.001 + 1,250 GB-s $0.0208                  -> $0.02
  //   high: 20,000 invocations $0.004 + 30,000 GB-s $0.50                 -> $0.50
  //   with free tier: what api left of Lambda's allowance covers it       -> $0.00
  //
  // totals: expected $0.2033 + $0.084 + $0.0853 + $14.38                  -> $14.75
  //         low $0.0808 + $0.042 + $0.0218 + $14.38                        -> $14.52
  //         high $0.74 + $0.168 + $0.504 + $14.38                          -> $15.79
  //   with free tier: only the HTTP API and the database bill             -> $14.48
  //   (low $14.43, high $14.58)
  it("prices the queue's requests and the worker's invocations and duration in dev", async () => {
    const { status, body } = await estimate(demoBlueprint, "dev");

    expect(status).toBe(200);
    expect(body.usage).toEqual({ requestsPerMonth: 100000, storageGb: 1, messagesPerMonth: 100000 });
    expect(Object.keys(body.intents)).toEqual(["api", "jobs", "worker", "db"]);
    expect(body.intents.jobs).toEqual({
      resolution: "sqs-standard",
      deployable: true,
      sizing: {
        visibilityTimeoutSeconds: { value: 60, source: "derived" },
        retentionDays: { value: 4, source: "derived" },
      },
      withoutFreeTier: { low: 0.04, expected: 0.08, high: 0.17 },
      withFreeTier: { low: 0, expected: 0, high: 0 },
      resources: [
        {
          resource: "SQS queue",
          withoutFreeTier: { low: 0.04, expected: 0.08, high: 0.17 },
          withFreeTier: { low: 0, expected: 0, high: 0 },
        },
        { resource: "dead-letter queue", ...noCharge },
      ],
    });
    expect(body.intents.worker).toEqual({
      resolution: "lambda-worker",
      deployable: true,
      sizing: {
        memoryMb: { value: 512, source: "derived" },
        timeoutSeconds: { value: 30, source: "derived" },
        batchSize: { value: 10, source: "derived" },
        maxConcurrency: { value: 2, source: "derived" },
      },
      withoutFreeTier: { low: 0.02, expected: 0.09, high: 0.5 },
      withFreeTier: { low: 0, expected: 0, high: 0 },
      resources: [
        {
          resource: "Lambda function",
          withoutFreeTier: { low: 0.02, expected: 0.09, high: 0.5 },
          withFreeTier: { low: 0, expected: 0, high: 0 },
        },
        { resource: "log group", ...noCharge },
        { resource: "execution role", ...noCharge },
        { resource: "event source mapping", ...noCharge },
      ],
    });
    expect(body.intents.api?.withoutFreeTier).toEqual({ low: 0.08, expected: 0.2, high: 0.74 });
    expect(body.intents.db?.withoutFreeTier).toEqual({ low: 14.38, expected: 14.38, high: 14.38 });
    expect(body.total).toEqual({
      withoutFreeTier: { low: 14.52, expected: 14.75, high: 15.79 },
      withFreeTier: { low: 14.43, expected: 14.48, high: 14.58 },
    });
  });

  // prod: 2,000,000 requests and messages, db.t4g.small pinned, the
  // worker's maxConcurrency pinned to 10. api $4.07 / $1.62 / $14.80
  // (with free tier $2.20 / $1.00 / $7.93) and db $26.06 as in the sample.
  //
  // jobs: 2M + 0.2M + 2M = 4.2M requests x $0.40                          -> $1.68
  //   low 2.1M -> $0.84; high 8.4M -> $3.36
  //   with free tier, 1M free: 3.2M -> $1.28; low 1.1M -> $0.44;
  //   high 7.4M -> $2.96
  //
  // worker, still the first message band (2M is under 5M):
  //   expected: 200,000 invocations $0.04 + 2M x 0.1 s x 0.5 GB =
  //             100,000 GB-s $1.6667                                       -> $1.71
  //   low: 100,000 invocations $0.02 + 25,000 GB-s $0.4167                -> $0.44
  //   high: 400,000 invocations $0.08 + 600,000 GB-s $10.00               -> $10.08
  //   with free tier, after api: expected, api took the million requests
  //   and 100,000 GB-s, so the invocations bill and the duration is within
  //   the 300,000 GB-s left                                                -> $0.04
  //   low: api took the million requests and 25,000 GB-s                   -> $0.02
  //   high: api took everything                                            -> $10.08
  //
  // totals: expected $4.0667 + $1.68 + $1.7067 + $26.06                    -> $33.51
  //         low $1.6167 + $0.84 + $0.4367 + $26.06                          -> $28.95
  //         high $14.80 + $3.36 + $10.08 + $26.06                           -> $54.30
  //   with free tier: $2.20 + $1.28 + $0.04 + $26.06                        -> $29.58
  //   low $1.00 + $0.44 + $0.02 + $26.06 -> $27.52; high $7.9333 + $2.96 +
  //   $10.08 + $26.06 -> $47.03
  it("applies prod's usage profile and marks the worker's pinned concurrency as overridden", async () => {
    const { status, body } = await estimate(demoBlueprint, "prod");

    expect(status).toBe(200);
    expect(body.usage).toEqual({ requestsPerMonth: 2000000, storageGb: 1, messagesPerMonth: 2000000 });
    expect(body.intents.jobs?.withoutFreeTier).toEqual({ low: 0.84, expected: 1.68, high: 3.36 });
    expect(body.intents.jobs?.withFreeTier).toEqual({ low: 0.44, expected: 1.28, high: 2.96 });
    expect(body.intents.worker?.sizing).toEqual({
      memoryMb: { value: 512, source: "derived" },
      timeoutSeconds: { value: 30, source: "derived" },
      batchSize: { value: 10, source: "derived" },
      maxConcurrency: { value: 10, source: "overridden" },
    });
    expect(body.intents.worker?.withoutFreeTier).toEqual({ low: 0.44, expected: 1.71, high: 10.08 });
    expect(body.intents.worker?.withFreeTier).toEqual({ low: 0.02, expected: 0.04, high: 10.08 });
    expect(body.intents.worker?.resources[0]).toEqual({
      resource: "Lambda function",
      withoutFreeTier: { low: 0.44, expected: 1.71, high: 10.08 },
      withFreeTier: { low: 0.02, expected: 0.04, high: 10.08 },
    });
    expect(body.total).toEqual({
      withoutFreeTier: { low: 28.95, expected: 33.51, high: 54.3 },
      withFreeTier: { low: 27.52, expected: 29.58, high: 47.03 },
    });
  });

  // A queue nobody consumes: every message is received on its own, so the
  // receives are not batched: 100,000 x 3 = 0.3M x $0.40 -> $0.12.
  it("meters one receive per message when no tier consumes the queue", async () => {
    const noConsumer = demoBlueprint.replace("      - to: jobs\n        role: consume\n", "");

    const { body } = await estimate(noConsumer, "dev");

    expect(body.intents.jobs?.withoutFreeTier.expected).toBe(0.12);
    expect(body.intents.worker?.withoutFreeTier).toEqual({ low: 0, expected: 0, high: 0 });
  });

  it("sizes the queue and the worker up with a heavier message volume", async () => {
    const heavy = demoBlueprint.replace("  messagesPerMonth: 100000", "  messagesPerMonth: 10000000");

    const { body } = await estimate(heavy, "dev");

    expect(body.intents.jobs?.sizing).toEqual({
      visibilityTimeoutSeconds: { value: 120, source: "derived" },
      retentionDays: { value: 7, source: "derived" },
    });
    expect(body.intents.worker?.sizing).toEqual({
      memoryMb: { value: 1024, source: "derived" },
      timeoutSeconds: { value: 60, source: "derived" },
      batchSize: { value: 10, source: "derived" },
      maxConcurrency: { value: 5, source: "derived" },
    });
  });
});

describe("GET /estimate sizing derivation", () => {
  const withUsage = (requestsPerMonth: number, storageGb: number) =>
    sampleBlueprint
      .replace("requestsPerMonth: 100000", `requestsPerMonth: ${requestsPerMonth}`)
      .replace("storageGb: 1", `storageGb: ${storageGb}`);

  it("sizes up with a heavier usage profile", async () => {
    const { body } = await estimate(withUsage(10_000_000, 25), "dev");

    expect(body.intents.api?.sizing).toEqual({
      memoryMb: { value: 1024, source: "derived" },
      timeoutSeconds: { value: 10, source: "derived" },
    });
    expect(body.intents.db?.sizing).toEqual({
      instanceClass: { value: "db.t4g.small", source: "derived" },
      storageGb: { value: 30, source: "derived" },
      multiAz: { value: false, source: "derived" },
    });
  });

  it("caps at the heaviest band", async () => {
    const { body } = await estimate(withUsage(100_000_000, 100), "dev");

    expect(body.intents.api?.sizing.memoryMb).toEqual({ value: 1024, source: "derived" });
    expect(body.intents.db?.sizing.instanceClass).toEqual({ value: "db.t4g.medium", source: "derived" });
    expect(body.intents.db?.sizing.storageGb).toEqual({ value: 100, source: "derived" });
  });
});

// Missing environment, unknown environment, invalid blueprint, missing file:
// the answers every environment route shares are in environment-routes.test.ts.
describe("GET /estimate errors", () => {
  const failing = (text: string, path: string) => get<ErrorResponse>(text, path);

  it("rejects an override outside the range its parameter accepts", async () => {
    const { status, body } = await failing(
      sampleBlueprint.replace("      db:\n        instanceClass: db.t4g.small", "      api:\n        memoryMb: 0"),
      "/estimate?environment=prod",
    );

    expect(status).toBe(422);
    expect(body).toEqual({ error: "sizing of lambda-api-gateway is not valid: memoryMb: Too small: expected number to be >0" });
  });

  it("rejects an instance class the pricing snapshot does not cover", async () => {
    const { status, body } = await failing(
      sampleBlueprint.replace("db.t4g.small", "db.r6g.large"),
      "/estimate?environment=prod",
    );

    expect(status).toBe(422);
    expect(body).toEqual({
      error:
        'no price in the aws us-east-1 snapshot for RDS instance class "db.r6g.large"; priced classes are db.t4g.micro, db.t4g.small, db.t4g.medium',
    });
  });
});
