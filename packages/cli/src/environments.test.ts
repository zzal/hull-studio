import { readFileSync } from "node:fs";
import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import type { Program } from "@hull/compiler";
import { demoBlueprint, directoryWithSample, fakeEngine, fakeProvider, passphraseFile, runHull, stateBucket } from "./deploy/fakes.js";

// Two environments from one directory: `hull deploy --env prod` beside
// `dev` are two stacks on the same state bucket and passphrase, each with
// its environment's sizing, and `hull destroy --env prod` leaves dev alone.
// Nothing in the CLI changes for this; these tests prove it.

// The inputs of one resource type the program declares, under the mock runtime.
async function inputsOf(program: Program, type: string): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  await pulumi.runtime.setMocks(
    {
      newResource(args) {
        if (args.type === type) found.push(args.inputs);
        const extra: Record<string, unknown> =
          args.type === "aws:rds/instance:Instance"
            ? { address: "db.internal", port: 5432, masterUserSecrets: [{ secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db" }] }
            : args.type === "aws:apigatewayv2/api:Api"
              ? { apiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc" }
              : args.type === "aws:sqs/queue:Queue"
                ? { url: `https://sqs.us-east-1.amazonaws.com/123456789012/${args.name}` }
                : {};
        return { id: `${args.name}-id`, state: { ...args.inputs, name: args.name, arn: `arn:${args.name}`, invokeArn: `invoke:${args.name}`, ...extra } };
      },
      call(args) {
        if (args.token === "aws:ec2/getVpc:getVpc") return { id: "vpc-1" };
        if (args.token === "aws:ec2/getSubnets:getSubnets") return { ids: ["subnet-a", "subnet-b"] };
        throw new Error(`unexpected provider call ${args.token}`);
      },
    },
    "todos",
    "prod",
    false,
  );
  await pulumi.runtime.runInPulumiStack(program);
  await pulumi.runtime.disconnect();
  return found;
}

describe("hull deploy --env prod beside dev", () => {
  it("passes two stack targets differing only in the stack name, on one bucket and passphrase", async () => {
    const directory = directoryWithSample({ blueprint: demoBlueprint });
    const dev = fakeEngine();
    const prod = fakeEngine();

    await runHull(directory, "deploy", { engine: dev.engine });
    await runHull(directory, "deploy", { engine: prod.engine, provider: fakeProvider({ existingBuckets: [stateBucket] }).provider, args: ["--env", "prod", "--yes"] });

    const devUp = dev.calls.find((call) => call.method === "up")!;
    const prodUp = prod.calls.find((call) => call.method === "up")!;
    expect(devUp.target).toEqual({
      project: "todos",
      stack: "dev",
      region: "us-east-1",
      backendUrl: `s3://${stateBucket}?region=us-east-1`,
      passphrase: readFileSync(passphraseFile(directory), "utf8"),
    });
    expect(prodUp.target).toEqual({ ...devUp.target, stack: "prod" });
  });

  it("declares prod's sizing in the prod program: the pinned instance class and the pinned concurrency", async () => {
    const directory = directoryWithSample({ blueprint: demoBlueprint });
    const { calls, engine } = fakeEngine();

    await runHull(directory, "deploy", { engine, args: ["--env", "prod", "--yes"] });

    const program = calls.find((call) => call.method === "up")!.program as Program;
    expect(await inputsOf(program, "aws:rds/instance:Instance")).toMatchObject([{ instanceClass: "db.t4g.small" }]);
    expect(await inputsOf(program, "aws:lambda/eventSourceMapping:EventSourceMapping")).toMatchObject([{ batchSize: 10, scalingConfig: { maximumConcurrency: 10 } }]);
  }, 30000);

  it("bundles the worker's entry too, and regenerates the bindings with the queue", async () => {
    const directory = directoryWithSample({ blueprint: demoBlueprint });

    const lines = await runHull(directory, "deploy");

    expect(lines).toContain("Wrote .hull/bindings/index.ts.");
    expect(readFileSync(`${directory}/.hull/bindings/index.ts`, "utf8")).toContain("export const jobs");
  });
});

describe("hull destroy --env prod", () => {
  it("calls the engine for the prod target only", async () => {
    const directory = directoryWithSample({ blueprint: demoBlueprint });
    await runHull(directory, "deploy");
    await runHull(directory, "deploy", { provider: fakeProvider({ existingBuckets: [stateBucket] }).provider, args: ["--env", "prod", "--yes"] });
    const { calls, engine } = fakeEngine();

    await runHull(directory, "destroy", { engine, args: ["--env", "prod"] });

    expect(calls.map((call) => [call.method, call.target?.stack])).toEqual([
      ["check", undefined],
      ["destroy", "prod"],
      ["removeStack", "prod"],
    ]);
  });
});
