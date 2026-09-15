import { describe, expect, it } from "vitest";
import { pricing } from "./pricing.js";
import { offerUrl, refreshPrices, skuCount, type OfferFile, type OfferFiles } from "./refresh.js";

// The pricing refresh, below the network: given the seven offer files of the
// AWS Price List Bulk API for one region, the snapshot's prices come from
// exactly the SKUs the six resolutions use, and the free tier rules are
// carried over from the snapshot on disk, never from the API. The fixtures
// are shaped like the real files, decoys included.

type Product = { family: string; attributes: Record<string, string>; prices: [begin: string, usd: string][] };

// An offer file holding the products given, each with one on-demand term.
function offer(offerCode: string, publicationDate: string, products: Product[]): OfferFile {
  const file: OfferFile = { offerCode, version: publicationDate.replace(/\D/g, ""), publicationDate, products: {}, terms: { OnDemand: {} } };
  products.forEach(({ family, attributes, prices }, index) => {
    const sku = `${offerCode}-${index}`;
    file.products[sku] = { productFamily: family, attributes: { regionCode: "us-east-1", ...attributes } };
    const dimensions = Object.fromEntries(
      prices.map(([beginRange, usd], tier) => [`${sku}.${tier}`, { beginRange, endRange: "Inf", unit: "u", pricePerUnit: { USD: usd } }]),
    );
    file.terms.OnDemand[sku] = { [`${sku}.term`]: { priceDimensions: dimensions } };
  });
  return file;
}

const rdsInstance = (instanceType: string, deploymentOption: string, usd: string): Product => ({
  family: "Database Instance",
  attributes: { instanceType, deploymentOption, databaseEngine: "PostgreSQL", usagetype: `${deploymentOption === "Multi-AZ" ? "Multi-AZUsage" : "InstanceUsage"}:${instanceType}` },
  prices: [["0", usd]],
});
const rdsStorage = (deploymentOption: string, databaseEngine: string, usd: string): Product => ({
  family: "Database Storage",
  attributes: { volumeType: "General Purpose-GP3", deploymentOption, databaseEngine, usagetype: deploymentOption === "Multi-AZ" ? "RDS:Multi-AZ-GP3-Storage" : "RDS:GP3-Storage" },
  prices: [["0", usd]],
});

function offers(): OfferFiles {
  return {
    AWSLambda: offer("AWSLambda", "2026-09-11T17:35:10Z", [
      { family: "Serverless", attributes: { group: "AWS-Lambda-Requests", usagetype: "Request" }, prices: [["0", "0.0000002000"]] },
      { family: "Serverless", attributes: { group: "AWS-Lambda-Duration", usagetype: "Lambda-GB-Second" }, prices: [["0", "0.0000166667"], ["6000000000", "0.0000150000"]] },
      // Decoys: arm64 duration, provisioned concurrency, another region.
      { family: "Serverless", attributes: { group: "AWS-Lambda-Duration-ARM", usagetype: "Lambda-GB-Second-ARM" }, prices: [["0", "0.0000133334"]] },
      { family: "Serverless", attributes: { group: "AWS-Lambda-Provisioned-Concurrency", usagetype: "Lambda-Provisioned-Concurrency" }, prices: [["0", "0.0000041667"]] },
      { family: "Serverless", attributes: { regionCode: "eu-west-1", group: "AWS-Lambda-Requests", usagetype: "EUW1-Request" }, prices: [["0", "0.0000009000"]] },
    ]),
    AmazonApiGateway: offer("AmazonApiGateway", "2026-09-11T12:44:08Z", [
      { family: "API Calls", attributes: { usagetype: "USE1-ApiGatewayHttpRequest", operation: "ApiGatewayHttpApi" }, prices: [["0", "0.0000010000"], ["300000000", "0.0000009000"]] },
      { family: "API Calls", attributes: { usagetype: "USE1-ApiGatewayRequest", operation: "ApiGatewayRequest" }, prices: [["0", "0.0000035000"]] },
    ]),
    AmazonRDS: offer("AmazonRDS", "2026-09-11T12:45:02Z", [
      rdsInstance("db.t4g.micro", "Single-AZ", "0.0160000000"),
      rdsInstance("db.t4g.small", "Single-AZ", "0.0320000000"),
      rdsInstance("db.t4g.medium", "Single-AZ", "0.0650000000"),
      rdsInstance("db.t4g.micro", "Multi-AZ", "0.0320000000"),
      // Multi-AZ is its own SKU, not a clean double: the real small and
      // medium prices as of 2026-09.
      rdsInstance("db.t4g.small", "Multi-AZ", "0.0650000000"),
      rdsInstance("db.t4g.medium", "Multi-AZ", "0.1290000000"),
      rdsStorage("Single-AZ", "PostgreSQL", "0.1150000000"),
      rdsStorage("Multi-AZ", "PostgreSQL", "0.2300000000"),
      // Decoys: other engines, a MySQL micro.
      rdsStorage("Single-AZ", "Oracle", "0.1150000000"),
      rdsStorage("Multi-AZ (readable standbys)", "PostgreSQL", "0.3450000000"),
      { family: "Database Instance", attributes: { instanceType: "db.t4g.micro", deploymentOption: "Single-AZ", databaseEngine: "MySQL", usagetype: "InstanceUsage:db.t4g.micro" }, prices: [["0", "0.0160000000"]] },
    ]),
    AWSSecretsManager: offer("AWSSecretsManager", "2026-09-11T12:46:10Z", [
      { family: "Secret", attributes: { usagetype: "USE1-AWSSecretsManager-Secrets" }, prices: [["0", "0.4000000000"]] },
      { family: "API Request", attributes: { usagetype: "USE1-AWSSecretsManagerAPIRequest" }, prices: [["0", "0.0000050000"]] },
    ]),
    AmazonECS: offer("AmazonECS", "2026-09-11T12:44:25Z", [
      { family: "Compute", attributes: { usagetype: "USE1-Fargate-vCPU-Hours:perCPU" }, prices: [["0", "0.0404800000"]] },
      { family: "Compute", attributes: { usagetype: "USE1-Fargate-GB-Hours" }, prices: [["0", "0.0044450000"]] },
      { family: "Compute", attributes: { usagetype: "USE1-Fargate-ARM-vCPU-Hours:perCPU" }, prices: [["0", "0.0323800000"]] },
      { family: "Compute", attributes: { usagetype: "USE1-Fargate-Windows-vCPU-Hours:perCPU" }, prices: [["0", "0.0910400000"]] },
    ]),
    AWSELB: offer("AWSELB", "2026-09-11T12:45:44Z", [
      { family: "Load Balancer-Application", attributes: { usagetype: "LoadBalancerUsage" }, prices: [["0", "0.0225000000"]] },
      { family: "Load Balancer-Application", attributes: { usagetype: "LCUUsage" }, prices: [["0", "0.0080000000"]] },
      { family: "Load Balancer-Application", attributes: { usagetype: "Outposts-LoadBalancerUsage" }, prices: [["0", "0.0225000000"]] },
      { family: "Load Balancer-Application", attributes: { usagetype: "ReservedLCUUsage" }, prices: [["0", "0.0080000000"]] },
      { family: "Load Balancer-Application", attributes: { usagetype: "TS-LoadBalancerUsage" }, prices: [["0", "0.0050000000"]] },
      { family: "Load Balancer", attributes: { usagetype: "LoadBalancerUsage" }, prices: [["0", "0.0250000000"]] },
    ]),
    AWSQueueService: offer("AWSQueueService", "2026-09-11T12:46:07Z", [
      { family: "API Request", attributes: { group: "SQS-APIRequest-Tier1", usagetype: "Requests-RBP", queueType: "Standard" }, prices: [["0", "0.0000004000"], ["100000000000", "0.0000003000"]] },
      // Decoys: FIFO and fair queues.
      { family: "API Request", attributes: { group: "SQS-APIRequest-Tier1", usagetype: "Requests-FIFO-RBP", queueType: "FIFO (first-in, first-out)" }, prices: [["0", "0.0000005000"]] },
      { family: "API Request", attributes: { group: "SQS-APIRequest-Tier1", usagetype: "Requests-Fair-RBP", queueType: "Fair" }, prices: [["0", "0.0000001000"]] },
    ]),
  };
}

describe("refreshPrices", () => {
  it("prices the snapshot from exactly the seventeen SKUs the six resolutions use", () => {
    const snapshot = refreshPrices(offers(), "us-east-1", pricing.freeTier);

    expect(skuCount).toBe(17);
    expect(snapshot).toMatchObject({
      provider: "aws",
      region: "us-east-1",
      currency: "USD",
      hoursPerMonth: 730,
      lambda: { perMillionRequests: 0.2, perGbSecond: 0.0000166667 },
      apiGateway: { http: { perMillionRequests: 1 } },
      rds: {
        postgres: {
          instanceHour: {
            "db.t4g.micro": { singleAz: 0.016, multiAz: 0.032 },
            "db.t4g.small": { singleAz: 0.032, multiAz: 0.065 },
            "db.t4g.medium": { singleAz: 0.065, multiAz: 0.129 },
          },
          storageGbMonth: { gp3: { singleAz: 0.115, multiAz: 0.23 } },
        },
      },
      secretsManager: { secretMonth: 0.4 },
      sqs: { perMillionRequests: 0.4 },
      fargate: { vcpuHour: 0.04048, gbHour: 0.004445 },
      applicationLoadBalancer: { hour: 0.0225, lcuHour: 0.008 },
    });
  });

  it("dates the snapshot by the newest offer file and names the offer versions, so a rerun on the same files is identical", () => {
    const first = refreshPrices(offers(), "us-east-1", pricing.freeTier);
    const second = refreshPrices(offers(), "us-east-1", pricing.freeTier);

    expect(first.publishedAt).toBe("2026-09-11T17:35:10Z");
    expect(first.source).toBe(
      "AWS Price List Bulk API, current offer files for us-east-1: AWSLambda 20260911173510, AmazonApiGateway 20260911124408, AmazonRDS 20260911124502, AWSSecretsManager 20260911124610, AmazonECS 20260911124425, AWSELB 20260911124544, AWSQueueService 20260911124607",
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("carries the free tier rules over from the snapshot on disk, untouched", () => {
    const snapshot = refreshPrices(offers(), "us-east-1", pricing.freeTier);

    expect(snapshot.freeTier).toEqual(pricing.freeTier);
  });

  it("refuses a SKU it cannot find or finds twice, naming it", () => {
    const missing = offers();
    delete missing.AWSSecretsManager.products["AWSSecretsManager-0"];
    const twice = offers();
    twice.AWSELB.products["AWSELB-copy"] = twice.AWSELB.products["AWSELB-1"]!;

    expect(() => refreshPrices(missing, "us-east-1", pricing.freeTier)).toThrow("no SKU in AWSSecretsManager for us-east-1 matches the Secrets Manager secret month");
    expect(() => refreshPrices(twice, "us-east-1", pricing.freeTier)).toThrow("2 SKUs in AWSELB for us-east-1 match the Application Load Balancer capacity unit hour");
  });

  it("reads the current offer file of a region from the public price list host", () => {
    expect(offerUrl("AmazonRDS", "eu-west-1")).toBe("https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-west-1/index.json");
  });
});
