import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import {
  account,
  apiUrl,
  directoryWithSample,
  fakeEngine,
  fakeProvider,
  passphraseFile,
  runHull,
  sampleBlueprint,
  stateBucket,
  stateFile,
} from "./deploy/fakes.js";
// The command loads the compiler, and with it Pulumi's SDK, on first use;
// loaded here so that time is not charged to the first test.
import { type Program } from "@hull/compiler";

// Seam 2 from the milestone 1 spec: `hull deploy --env dev` run in a
// temporary directory against a fake deploy engine and a fake provider account,
// checked by the state file, the passphrase file, what reaches the engine,
// and the lines rendered from synthetic progress events. No AWS, no Pulumi.

const runDeploy = (directory: string, fakes?: Parameters<typeof runHull>[2]) => runHull(directory, "deploy", fakes);

type Declared = { type: string; name: string; inputs: Record<string, unknown> };

// The resources a compiled program declares, with their inputs, under
// Pulumi's mock runtime: what Pulumi would diff against the stack's state.
async function declaredBy(program: Program): Promise<Declared[]> {
  const declared: Declared[] = [];
  await pulumi.runtime.setMocks(
    {
      newResource(args) {
        declared.push({ type: args.type, name: args.name, inputs: args.inputs });
        const extra: Record<string, unknown> =
          args.type === "aws:rds/instance:Instance"
            ? { address: "db.internal", port: 5432, masterUserSecrets: [{ secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db" }] }
            : args.type === "aws:apigatewayv2/api:Api"
              ? { apiEndpoint: apiUrl, executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc" }
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
    "dev",
    false,
  );
  await pulumi.runtime.runInPulumiStack(program);
  await pulumi.runtime.disconnect();
  return declared.filter((resource) => resource.type !== "pulumi:pulumi:Stack");
}

describe("hull deploy --env dev, first deploy", () => {
  it("records the state bucket it bootstrapped in the committed state file", async () => {
    const directory = directoryWithSample();
    const { calls, provider } = fakeProvider();

    await runDeploy(directory, { provider });

    expect(calls).toEqual([
      { method: "identity", args: ["us-east-1"] },
      { method: "ensureStateBucket", args: [stateBucket, "us-east-1"] },
    ]);
    expect(JSON.parse(readFileSync(stateFile(directory), "utf8"))).toEqual({ stateBucket });
  });

  it("generates the passphrase once, readable by the owner only, and reuses it on the next deploy", async () => {
    const directory = directoryWithSample();
    const first = fakeEngine();

    await runDeploy(directory, { engine: first.engine });

    const passphrase = readFileSync(passphraseFile(directory), "utf8");
    expect(passphrase).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(passphraseFile(directory)).mode & 0o777).toBe(0o600);
    expect(first.calls.find((call) => call.method === "up")?.target?.passphrase).toBe(passphrase);

    const second = fakeEngine();
    await runDeploy(directory, { engine: second.engine, provider: fakeProvider({ existingBuckets: [stateBucket] }).provider });

    expect(readFileSync(passphraseFile(directory), "utf8")).toBe(passphrase);
    expect(second.calls.find((call) => call.method === "up")?.target?.passphrase).toBe(passphrase);
  });

  it("passes the compiled program and the environment's stack on the state bucket to the engine", async () => {
    const directory = directoryWithSample();
    const { calls, engine } = fakeEngine();

    await runDeploy(directory, { engine });

    expect(calls.map((call) => call.method)).toEqual(["check", "up"]);
    const up = calls[1]!;
    expect(up.target).toEqual({
      project: "todos",
      stack: "dev",
      region: "us-east-1",
      backendUrl: `s3://${stateBucket}?region=us-east-1`,
      passphrase: readFileSync(passphraseFile(directory), "utf8"),
    });
    expect(typeof up.program).toBe("function");
  });

  it("regenerates the bindings", async () => {
    const directory = directoryWithSample();

    await runDeploy(directory);

    const bindings = readFileSync(join(directory, ".hull", "bindings", "index.ts"), "utf8");
    expect(bindings.split("\n")[0]).toMatch(/generated.*do not edit/i);
    expect(bindings).toContain("export const db");
  });

  it("renders one line per resource event, the summary, and the API URL from the stack output", async () => {
    const directory = directoryWithSample();
    const { engine } = fakeEngine({
      upEvents: [
        { phase: "started", operation: "create", type: "aws:ec2/securityGroup:SecurityGroup", name: "db" },
        { phase: "done", operation: "create", type: "aws:ec2/securityGroup:SecurityGroup", name: "db" },
        { phase: "started", operation: "create", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "failed", operation: "create", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "diagnostic", severity: "error", message: "creating RDS DB Instance: InsufficientDBInstanceCapacity\n" },
        { phase: "summary", changes: { create: 1, same: 2 }, durationSeconds: 381 },
      ],
    });

    const lines = await runDeploy(directory, { engine });

    expect(lines).toEqual([
      `Deploying todos to dev in us-east-1 (account ${account}, profile sandbox).`,
      `Created the state bucket ${stateBucket} and recorded it in .hull/state.json; commit that file.`,
      "Generated the deploy secrets passphrase in .hull/passphrase; keep it, it unlocks this environment's state.",
      "Wrote .hull/bindings/index.ts.",
      "  started  create  aws:ec2/securityGroup:SecurityGroup  db",
      "  done     create  aws:ec2/securityGroup:SecurityGroup  db",
      "  started  create  aws:rds/instance:Instance  db",
      "  failed   create  aws:rds/instance:Instance  db",
      "  error: creating RDS DB Instance: InsufficientDBInstanceCapacity",
      "Summary: 1 created, 2 unchanged in 6m 21s.",
      `API URL: ${apiUrl}`,
      `Try: curl ${apiUrl}/todos`,
    ]);
  });
});

describe("hull deploy --env dev, later deploys", () => {
  it("reuses the recorded state bucket and says so", async () => {
    const directory = directoryWithSample();
    await runDeploy(directory);
    const { calls, provider } = fakeProvider({ existingBuckets: [stateBucket] });

    const lines = await runDeploy(directory, { provider });

    expect(calls[1]).toEqual({ method: "ensureStateBucket", args: [stateBucket, "us-east-1"] });
    expect(lines).toContain(`State bucket ${stateBucket}.`);
    expect(lines).not.toContainEqual(expect.stringMatching(/passphrase/));
  });

  it("sends the engine the same stack and the same resources on an unchanged blueprint, so the run is a no-op", async () => {
    const directory = directoryWithSample();
    const first = fakeEngine();
    const second = fakeEngine();

    await runDeploy(directory, { engine: first.engine });
    await runDeploy(directory, { engine: second.engine, provider: fakeProvider({ existingBuckets: [stateBucket] }).provider });

    const firstUp = first.calls.find((call) => call.method === "up")!;
    const secondUp = second.calls.find((call) => call.method === "up")!;
    expect(secondUp.target).toEqual(firstUp.target);
    expect(await declaredBy(secondUp.program as Program)).toEqual(await declaredBy(firstUp.program as Program));
  }, 30000);

  it("refuses a missing passphrase when the state file records a bucket, before any cloud call", async () => {
    const directory = directoryWithSample();
    mkdirSync(join(directory, ".hull"));
    writeFileSync(stateFile(directory), JSON.stringify({ stateBucket }));
    const engine = fakeEngine();
    const provider = fakeProvider({ existingBuckets: [stateBucket] });

    await expect(runDeploy(directory, { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      `no .hull/passphrase, but .hull/state.json records the state bucket ${stateBucket}: this environment was deployed before and its state is locked with that passphrase. Copy .hull/passphrase from the machine that first deployed; Hull never regenerates it.`,
    );

    expect(provider.calls).toEqual([]);
    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
    expect(existsSync(passphraseFile(directory))).toBe(false);
  });
});

describe("hull deploy pre-flight", () => {
  it("requires --env", async () => {
    await expect(runDeploy(directoryWithSample(), { args: [] })).rejects.toThrow(/--env/);
  });

  it("refuses an environment the blueprint does not declare", async () => {
    await expect(runDeploy(directoryWithSample(), { args: ["--env", "staging"] })).rejects.toThrow(
      'no environment "staging" in hull.yaml; environments are dev',
    );
  });

  it("reports the missing Pulumi CLI before anything else", async () => {
    const engine = fakeEngine({ cliMissing: true });
    const provider = fakeProvider();

    await expect(runDeploy(directoryWithSample(), { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      "the Pulumi CLI is not usable (not found in PATH); if it is missing, install it",
    );

    expect(provider.calls).toEqual([]);
  });

  it("reports an invalid blueprint with its diagnostics and makes no cloud call", async () => {
    const provider = fakeProvider();
    const directory = directoryWithSample({ blueprint: sampleBlueprint.replace("lambda-api-gateway", "fargate-api") });

    await expect(runDeploy(directory, { provider: provider.provider })).rejects.toThrow(
      /hull\.yaml is not valid:\n  intents\.api\.resolution: "fargate-api" is not a candidate resolution/,
    );

    expect(provider.calls).toEqual([]);
  });

  it("reports a missing entry file and makes no cloud call", async () => {
    const provider = fakeProvider();

    await expect(runDeploy(directoryWithSample({ entry: false }), { provider: provider.provider })).rejects.toThrow(
      "no entry src/api/index.ts for intent api; hull.yaml points at a file that does not exist",
    );

    expect(provider.calls).toEqual([]);
  });

  it("reports missing credentials and calls nothing else", async () => {
    const engine = fakeEngine();
    const directory = directoryWithSample();

    await expect(runDeploy(directory, { engine: engine.engine, provider: fakeProvider({ noCredentials: true }).provider })).rejects.toThrow(
      'no AWS credentials found for profile "sandbox" in region us-east-1',
    );

    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
    expect(existsSync(stateFile(directory))).toBe(false);
  });

  it("refuses to deploy without a blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-cli-"));

    await expect(runDeploy(directory)).rejects.toThrow(`no hull.yaml in ${directory}; run \`hull init\` first`);
  });
});
