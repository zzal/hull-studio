import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStudioServer, type ErrorResponse, type EstimateResponse } from "./index.js";
import { get, sampleBlueprint } from "./testing.js";

// GET /estimate?environment=<name>: the blueprint merged for that environment
// (usage profile, derived sizing with overrides marked), the monthly figures per
// intent and in total, with and without free tier.
//
// Expected figures are worked by hand from the pricing snapshot in
// packages/catalog/pricing/aws.json (us-east-1, 730 hours a month) and the
// three scenarios of the cost model: low = half the requests at 50 ms per
// Lambda invocation, expected = the profile at 100 ms, high = double at 300 ms.

const estimate = (text: string, environment: string) =>
  get<EstimateResponse>(text, `/estimate?environment=${environment}`);

describe("GET /estimate for the sample blueprint's dev environment", () => {
  // 100,000 requests a month, 1 GB stored.
  //
  // api on lambda-api-gateway, derived 512 MB / 10 s:
  //   expected: requests 0.1M x $0.20 = $0.02
  //             duration 100,000 x 0.1 s x 0.5 GB = 5,000 GB-s x $0.0000166667 = $0.0833
  //             API Gateway 0.1M x $1.00 = $0.10                          -> $0.20
  //   low:      50,000 requests, 1,250 GB-s: $0.01 + $0.0208 + $0.05     -> $0.08
  //   high:     200,000 requests, 30,000 GB-s: $0.04 + $0.50 + $0.20     -> $0.74
  //   with free tier: under 1M requests and 400,000 GB-s everywhere       -> $0
  //
  // db on rds-postgres, derived db.t4g.micro / 20 GB / single-AZ:
  //   730 h x $0.016 = $11.68, 20 GB x $0.115 = $2.30, managed password
  //   secret $0.40; the same at every load                               -> $14.38
  //   with free tier: 750 instance hours and 20 GB storage free           -> $0.40
  it("derives the low-end sizing and estimates each intent and the total", async () => {
    const { status, body } = await estimate(sampleBlueprint, "dev");

    expect(status).toBe(200);
    expect(body).toEqual({
      environment: "dev",
      usage: { requestsPerMonth: 100000, storageGb: 1 },
      freeTierLabel: "assumes classic free tier",
      intents: {
        api: {
          resolution: "lambda-api-gateway",
          sizing: {
            memoryMb: { value: 512, source: "derived" },
            timeoutSeconds: { value: 10, source: "derived" },
          },
          withoutFreeTier: { low: 0.08, expected: 0.2, high: 0.74 },
          withFreeTier: { low: 0, expected: 0, high: 0 },
        },
        db: {
          resolution: "rds-postgres",
          sizing: {
            instanceClass: { value: "db.t4g.micro", source: "derived" },
            storageGb: { value: 20, source: "derived" },
            multiAz: { value: false, source: "derived" },
          },
          withoutFreeTier: { low: 14.38, expected: 14.38, high: 14.38 },
          withFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
        },
      },
      total: {
        withoutFreeTier: { low: 14.46, expected: 14.58, high: 15.12 },
        withFreeTier: { low: 0.4, expected: 0.4, high: 0.4 },
      },
    });
  });
});

describe("GET /estimate for the sample blueprint's prod environment", () => {
  // 2,000,000 requests a month (the environment's usage profile over the
  // base), 1 GB stored (from the base), instanceClass pinned to db.t4g.small.
  //
  // api, still 512 MB / 10 s (under 5M requests):
  //   expected: 2M requests: $0.40 + 100,000 GB-s $1.6667 + gateway $2.00  -> $4.07
  //   low:      1M requests: $0.20 + 25,000 GB-s $0.4167 + gateway $1.00   -> $1.62
  //   high:     4M requests: $0.80 + 600,000 GB-s $10.00 + gateway $4.00   -> $14.80
  //   with free tier (1M requests, 400,000 GB-s, 1M gateway requests free):
  //     expected: 1M x $0.20 + 0 + 1M x $1.00                              -> $1.20
  //     low: everything within the allowances                              -> $0
  //     high: 3M x $0.20 + 200,000 GB-s x $0.0000166667 + 3M x $1.00      -> $6.93
  //
  // db pinned to db.t4g.small, derived 20 GB / single-AZ:
  //   730 h x $0.032 = $23.36 + $2.30 storage + $0.40 secret               -> $26.06
  //   with free tier: db.t4g.small is not eligible, so neither its hours
  //   nor its storage are free                                             -> $26.06
  it("applies the environment's usage profile and marks the pinned instance class as overridden", async () => {
    const { status, body } = await estimate(sampleBlueprint, "prod");

    expect(status).toBe(200);
    expect(body).toEqual({
      environment: "prod",
      usage: { requestsPerMonth: 2000000, storageGb: 1 },
      freeTierLabel: "assumes classic free tier",
      intents: {
        api: {
          resolution: "lambda-api-gateway",
          sizing: {
            memoryMb: { value: 512, source: "derived" },
            timeoutSeconds: { value: 10, source: "derived" },
          },
          withoutFreeTier: { low: 1.62, expected: 4.07, high: 14.8 },
          withFreeTier: { low: 0, expected: 1.2, high: 6.93 },
        },
        db: {
          resolution: "rds-postgres",
          sizing: {
            instanceClass: { value: "db.t4g.small", source: "overridden" },
            storageGb: { value: 20, source: "derived" },
            multiAz: { value: false, source: "derived" },
          },
          withoutFreeTier: { low: 26.06, expected: 26.06, high: 26.06 },
          withFreeTier: { low: 26.06, expected: 26.06, high: 26.06 },
        },
      },
      total: {
        withoutFreeTier: { low: 27.68, expected: 30.13, high: 40.86 },
        withFreeTier: { low: 26.06, expected: 27.26, high: 32.99 },
      },
    });
  });

  // A second HTTP API in prod, also at 2M requests. The free tier is one
  // pool for the account: api draws the 1M free requests first, admin gets
  // none of them and only the 300,000 GB-s left.
  //   admin with free tier, expected: 2M x $0.20 + 0 + 2M x $1.00          -> $2.40
  //   total with free tier, expected: $1.20 + $2.40 + $26.06               -> $29.66
  //   total without: $4.0667 + $4.0667 + $26.06                            -> $34.19
  it("draws every intent from one free tier pool so the total never counts an allowance twice", async () => {
    const twoApis = sampleBlueprint.replace(
      "  db:\n",
      "  admin:\n    kind: http-api\n    resolution: lambda-api-gateway\n    entry: src/admin.ts\n\n  db:\n",
    );

    const { body } = await estimate(twoApis, "prod");

    expect(body.intents.api?.withFreeTier.expected).toBe(1.2);
    expect(body.intents.admin?.withFreeTier.expected).toBe(2.4);
    expect(body.total.withFreeTier.expected).toBe(29.66);
    expect(body.total.withoutFreeTier.expected).toBe(34.19);
  });

  // Multi-AZ doubles the instance hours and the storage and forfeits the
  // free tier: 2 x $11.68 + 2 x $2.30 + $0.40                              -> $28.36
  it("doubles the database and forfeits its free tier when multiAz is pinned", async () => {
    const multiAz = sampleBlueprint.replace("instanceClass: db.t4g.small", "multiAz: true");

    const { body } = await estimate(multiAz, "prod");

    expect(body.intents.db?.sizing.multiAz).toEqual({ value: true, source: "overridden" });
    expect(body.intents.db?.withoutFreeTier).toEqual({ low: 28.36, expected: 28.36, high: 28.36 });
    expect(body.intents.db?.withFreeTier).toEqual({ low: 28.36, expected: 28.36, high: 28.36 });
  });
});

describe("GET /estimate for an HTTP API on fargate-load-balancer", () => {
  // The dev profile (100,000 requests) with the api resolution switched.
  // Derived one task of 256 CPU units / 512 MB behind a load balancer.
  //   task: (0.25 vCPU x $0.04048 + 0.5 GB x $0.004445) x 730 h           -> $9.0100
  //   load balancer: 730 h x $0.0225                                       -> $16.425
  //   capacity units: 100,000 requests / (3600 s x 25 connections per
  //   unit) = 1.11 LCU-hours x $0.008                                      -> $0.0089
  //   expected $25.44; low (0.56 LCU-h) $25.44; high (2.22 LCU-h) $25.45
  //   with free tier: 750 load balancer hours and 15 LCU-hours free, the
  //   task is not                                                          -> $9.01
  it("estimates the task hours and the load balancer, with only the balancer in the free tier", async () => {
    const fargate = sampleBlueprint.replace("resolution: lambda-api-gateway", "resolution: fargate-load-balancer");

    const { status, body } = await estimate(fargate, "dev");

    expect(status).toBe(200);
    expect(body.intents.api).toEqual({
      resolution: "fargate-load-balancer",
      sizing: {
        cpu: { value: 256, source: "derived" },
        memoryMb: { value: 512, source: "derived" },
        desiredCount: { value: 1, source: "derived" },
      },
      withoutFreeTier: { low: 25.44, expected: 25.44, high: 25.45 },
      withFreeTier: { low: 9.01, expected: 9.01, high: 9.01 },
    });
    expect(body.total).toEqual({
      withoutFreeTier: { low: 39.82, expected: 39.82, high: 39.83 },
      withFreeTier: { low: 9.41, expected: 9.41, high: 9.41 },
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

describe("GET /estimate errors", () => {
  const failing = (text: string, path: string) => get<ErrorResponse>(text, path);

  it("requires an environment name", async () => {
    const { status, body } = await failing(sampleBlueprint, "/estimate");

    expect(status).toBe(400);
    expect(body).toEqual({ error: "environment query parameter is required" });
  });

  it("names the environments when asked for one the blueprint does not declare", async () => {
    const { status, body } = await failing(sampleBlueprint, "/estimate?environment=staging");

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'no environment "staging" in hull.yaml; environments are dev, prod' });
  });

  it("reports the diagnostics of an invalid blueprint instead of an estimate", async () => {
    const { status, body } = await failing(
      sampleBlueprint.replace("instanceClass: db.t4g.small", "storageGb: plenty"),
      "/estimate?environment=prod",
    );

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "hull.yaml is not valid",
      diagnostics: [
        {
          path: ["environments", "prod", "overrides", "db", "storageGb"],
          message: 'sizing parameter storageGb of resolution rds-postgres takes a number, not "plenty"',
        },
      ],
    });
  });

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

  it("answers 404 when the directory has no blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
    const response = await createStudioServer({ directory }).request("/estimate?environment=dev");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `no hull.yaml in ${directory}` });
  });
});
