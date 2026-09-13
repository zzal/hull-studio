import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ErrorResponse, RecommendationsResponse } from "./index.js";
import { get, sampleBlueprint, studioDirectoryOver } from "./testing.js";

// GET /recommendations?environment=<name>: for every intent whose kind has
// more than one candidate resolution, the candidates ranked at that
// environment's usage profile with one line of reasoning per trade-off
// dimension. The blueprint's own choice is reported beside the ranking and
// the file is never changed.
//
// Cost lines quote the expected monthly figure without free tier, worked by
// hand from packages/catalog/pricing/aws.json exactly as in estimate.test.ts.

const recommendations = (text: string, environment: string) =>
  get<RecommendationsResponse>(text, `/recommendations?environment=${environment}`);

describe("GET /recommendations for the sample blueprint's dev environment", () => {
  // 100,000 requests a month: Lambda expected $0.20, Fargate $25.44 (one task
  // and the load balancer are metered every hour whatever the traffic).
  it("ranks lambda-api-gateway first with a reason per dimension", async () => {
    const { status, body } = await recommendations(sampleBlueprint, "dev");

    expect(status).toBe(200);
    expect(body).toEqual({
      environment: "dev",
      usage: { requestsPerMonth: 100000, storageGb: 1 },
      intents: {
        api: {
          kind: "http-api",
          current: "lambda-api-gateway",
          recommended: "lambda-api-gateway",
          ranking: [
            {
              resolution: "lambda-api-gateway",
              expectedMonthly: 0.2,
              reasons: {
                cost: "$0.20 a month expected at 100,000 requests without free tier, the cheapest at this profile",
                opsBurden: "no servers, images or scaling policy to run; AWS patches the runtime",
                scalingCeiling: "scales per request up to the account's concurrency quota (1,000 by default), then throttles",
                coldStart: "a cold invocation after idle adds hundreds of milliseconds, so tail latency spikes at low traffic",
              },
            },
            {
              resolution: "fargate-load-balancer",
              expectedMonthly: 25.44,
              reasons: {
                cost: "$25.44 a month expected at 100,000 requests without free tier, $25.24 more than lambda-api-gateway",
                opsBurden: "a container image to build and patch, a cluster and a scaling policy to keep",
                scalingCeiling: "no per-request ceiling; capacity is the task count, raised by a scaling policy",
                coldStart: "always-on tasks answer without cold start",
              },
            },
          ],
        },
      },
    });
  });
});

describe("GET /recommendations at a heavier usage profile", () => {
  const withRequests = (requestsPerMonth: number) =>
    sampleBlueprint.replace("requestsPerMonth: 100000", `requestsPerMonth: ${requestsPerMonth}`);

  // prod: 2,000,000 requests. Lambda expected $4.07; Fargate one task and
  // the balancer $25.44 plus 22.2 LCU-hours ($0.18)                     -> $25.61
  it("keeps lambda-api-gateway first for the sample blueprint's prod environment", async () => {
    const { body } = await recommendations(sampleBlueprint, "prod");

    expect(body.usage.requestsPerMonth).toBe(2000000);
    expect(body.intents.api?.recommended).toBe("lambda-api-gateway");
    expect(body.intents.api?.ranking.map((r) => [r.resolution, r.expectedMonthly])).toEqual([
      ["lambda-api-gateway", 4.07],
      ["fargate-load-balancer", 25.61],
    ]);
  });

  // 20,000,000 requests a month, in the second band.
  //   Lambda at 1024 MB: 20M x $0.20 = $4.00, 2,000,000 GB-s x $0.0000166667
  //   = $33.33, gateway 20M x $1.00 = $20.00                              -> $57.33
  //   Fargate, two tasks: 2 x $9.01 = $18.02, balancer $16.425, 20M
  //   requests / (3600 s x 25) = 222.2 LCU-hours x $0.008 = $1.78         -> $36.22
  it("ranks fargate-load-balancer first once Lambda's per-request cost passes the always-on tasks", async () => {
    const { body } = await recommendations(withRequests(20_000_000), "dev");

    expect(body.intents.api?.recommended).toBe("fargate-load-balancer");
    expect(body.intents.api?.ranking.map((r) => [r.resolution, r.expectedMonthly])).toEqual([
      ["fargate-load-balancer", 36.22],
      ["lambda-api-gateway", 57.33],
    ]);
    expect(body.intents.api?.ranking[0]?.reasons.cost).toBe(
      "$36.22 a month expected at 20,000,000 requests without free tier, the cheapest at this profile",
    );
    expect(body.intents.api?.ranking[1]?.reasons.cost).toBe(
      "$57.33 a month expected at 20,000,000 requests without free tier, $21.11 more than fargate-load-balancer",
    );
  });
});

describe("GET /recommendations and the blueprint's own choice", () => {
  // The api on fargate-load-balancer with desiredCount pinned to 3 in dev:
  // the current resolution is priced as sized in the environment, 3 x $9.01
  // + $16.425 + $0.0089 = $43.46, so the line agrees with the estimate.
  it("prices the current resolution with its overrides and still proposes the cheaper candidate", async () => {
    const fargateWithThreeTasks = sampleBlueprint
      .replace("resolution: lambda-api-gateway", "resolution: fargate-load-balancer")
      .replace("  dev: {}\n", "  dev:\n    overrides:\n      api:\n        desiredCount: 3\n");

    const { body } = await recommendations(fargateWithThreeTasks, "dev");

    expect(body.intents.api?.current).toBe("fargate-load-balancer");
    expect(body.intents.api?.recommended).toBe("lambda-api-gateway");
    expect(body.intents.api?.ranking[1]).toMatchObject({
      resolution: "fargate-load-balancer",
      expectedMonthly: 43.46,
      reasons: {
        cost: "$43.46 a month expected at 100,000 requests without free tier, $43.26 more than lambda-api-gateway",
      },
    });
  });

  it("has nothing to say about an intent whose kind has a single candidate resolution", async () => {
    const { body } = await recommendations(sampleBlueprint, "dev");

    expect(Object.keys(body.intents)).toEqual(["api"]);
  });

  // Every answer, not only a ranking: a request that fails must not touch
  // the file either.
  it.each([
    ["/recommendations?environment=dev", 200],
    ["/recommendations", 400],
    ["/recommendations?environment=staging", 404],
  ])("leaves the blueprint file byte-identical after %s", async (path, status) => {
    const { app, directory } = studioDirectoryOver(sampleBlueprint);
    const before = readFileSync(join(directory, "hull.yaml"));

    const response = await app.request(path);

    expect(response.status).toBe(status);
    expect(readFileSync(join(directory, "hull.yaml")).equals(before)).toBe(true);
  });
});

// Missing environment, unknown environment, invalid blueprint, missing file:
// the answers every environment route shares are in environment-routes.test.ts.
describe("GET /recommendations errors", () => {
  it("rejects an override outside the range its parameter accepts", async () => {
    const { status, body } = await get<ErrorResponse>(
      sampleBlueprint.replace("      db:\n        instanceClass: db.t4g.small", "      api:\n        memoryMb: 0"),
      "/recommendations?environment=prod",
    );

    expect(status).toBe(422);
    expect(body).toEqual({ error: "sizing of lambda-api-gateway is not valid: memoryMb: Too small: expected number to be >0" });
  });
});
