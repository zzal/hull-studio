import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  account,
  deployedDirectory,
  directoryWithSample,
  fakeEngine,
  fakeProvider,
  passphraseFile,
  runHull,
  sampleBlueprint,
  stateBucket,
  stateFile,
} from "./deploy/fakes.js";
import { stateFileName } from "./deploy/state.js";

// `hull destroy --env dev` in a temporary directory as a deploy leaves it,
// against the fake engine and the fake account: the engine's destroy then
// removeStack, the state file and the bucket kept, the progress rendered
// from synthetic events. No AWS, no Pulumi.

const runDestroy = (directory: string, fakes?: Parameters<typeof runHull>[2]) => runHull(directory, "destroy", fakes);

describe("hull destroy --env dev", () => {
  it("destroys the environment's stack on the recorded state bucket, then removes the stack", async () => {
    const directory = deployedDirectory();
    const { calls, engine } = fakeEngine();

    await runDestroy(directory, { engine });

    expect(calls.map((call) => call.method)).toEqual(["check", "destroy", "removeStack"]);
    const target = {
      project: "todos",
      stack: "dev",
      region: "us-east-1",
      backendUrl: `s3://${stateBucket}?region=us-east-1`,
      passphrase: readFileSync(passphraseFile(directory), "utf8"),
    };
    expect(calls[1]!.target).toEqual(target);
    expect(calls[2]!.target).toEqual(target);
  });

  it("keeps the state file and the passphrase, and never touches the bucket", async () => {
    const directory = deployedDirectory();
    const state = readFileSync(stateFile(directory), "utf8");
    const passphrase = readFileSync(passphraseFile(directory), "utf8");
    const { calls, provider } = fakeProvider({ existingBuckets: [stateBucket] });

    await runDestroy(directory, { provider });

    expect(calls).toEqual([{ method: "identity", args: ["us-east-1"] }]);
    expect(readFileSync(stateFile(directory), "utf8")).toBe(state);
    expect(readFileSync(passphraseFile(directory), "utf8")).toBe(passphrase);
  });

  it("renders one line per resource event and the summary, as deploy does", async () => {
    const directory = deployedDirectory();
    const { engine } = fakeEngine({
      destroyEvents: [
        { phase: "started", operation: "delete", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "done", operation: "delete", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "started", operation: "delete", type: "aws:ec2/securityGroup:SecurityGroup", name: "db" },
        { phase: "done", operation: "delete", type: "aws:ec2/securityGroup:SecurityGroup", name: "db" },
        { phase: "summary", changes: { delete: 2 }, durationSeconds: 245 },
      ],
    });

    const lines = await runDestroy(directory, { engine });

    expect(lines).toEqual([
      `Destroying todos dev in us-east-1 (account ${account}, profile sandbox).`,
      "  started  delete  aws:rds/instance:Instance  db",
      "  done     delete  aws:rds/instance:Instance  db",
      "  started  delete  aws:ec2/securityGroup:SecurityGroup  db",
      "  done     delete  aws:ec2/securityGroup:SecurityGroup  db",
      "Summary: 2 deleted in 4m 5s.",
      `Removed dev from the state bucket ${stateBucket}; the bucket, .hull/state.json and .hull/passphrase are kept, so the next deploy starts from scratch.`,
    ]);
  });

  it("makes a deploy after it a first deploy again, on the same bucket and passphrase", async () => {
    const directory = directoryWithSample();
    await runHull(directory, "deploy");
    const passphrase = readFileSync(passphraseFile(directory), "utf8");
    await runDestroy(directory);
    const { calls, engine } = fakeEngine();

    const lines = await runHull(directory, "deploy", { engine, provider: fakeProvider({ existingBuckets: [stateBucket] }).provider });

    expect(lines).toContain(`State bucket ${stateBucket}.`);
    expect(calls.find((call) => call.method === "up")?.target?.passphrase).toBe(passphrase);
  });
});

describe("hull destroy --env dev, failed destroy", () => {
  it("names the failed resource and the provider's reason, and says to run it again", async () => {
    const { engine } = fakeEngine({
      destroyEvents: [
        { phase: "started", operation: "delete", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "diagnostic", severity: "error", name: "db", message: "deleting RDS DB Instance (db-1a2b): InvalidDBInstanceState: instance is being modified\n" },
        { phase: "failed", operation: "delete", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "summary", changes: { delete: 0 }, durationSeconds: 12 },
      ],
      fails: "the deploy engine stopped: update failed",
    });
    const lines: string[] = [];

    await expect(runDestroy(deployedDirectory(), { engine, lines })).rejects.toThrow(
      [
        "destroy of todos dev failed:",
        "  aws:rds/instance:Instance db: deleting RDS DB Instance (db-1a2b): InvalidDBInstanceState: instance is being modified",
        "What was removed is recorded in the environment's state: run `hull destroy --env dev` again to remove the rest.",
      ].join("\n"),
    );
    expect(lines).toContain("Summary: no changes in 12s.");
    expect(lines).not.toContainEqual(expect.stringMatching(/^Removed/));
  });

  it("says so when the resources are gone but the state could not be removed", async () => {
    const engine = fakeEngine().engine;
    engine.removeStack = async () => {
      throw new Error("the deploy engine stopped: error: could not remove the stack");
    };

    await expect(runDestroy(deployedDirectory(), { engine })).rejects.toThrow(
      [
        "destroy of todos dev failed: the deploy engine stopped: error: could not remove the stack",
        "Every resource is gone, but the environment's state is still in the bucket: run `hull destroy --env dev` again to remove it.",
      ].join("\n"),
    );
  });
});

describe("hull destroy pre-flight", () => {
  it("requires --env", async () => {
    await expect(runDestroy(deployedDirectory(), { args: [] })).rejects.toThrow(/--env/);
  });

  it("refuses an environment the blueprint does not declare", async () => {
    await expect(runDestroy(deployedDirectory(), { args: ["--env", "staging"] })).rejects.toThrow(
      'no environment "staging" in hull.yaml; environments are dev',
    );
  });

  it("refuses a directory that was never deployed, before any cloud call", async () => {
    const directory = directoryWithSample();
    const engine = fakeEngine();
    const provider = fakeProvider();

    await expect(runDestroy(directory, { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      `nothing to destroy: no ${stateFileName} in ${directory}, so nothing was deployed from here`,
    );

    expect(provider.calls).toEqual([]);
    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
  });

  it("refuses a missing passphrase when the state file records a bucket, before any cloud call", async () => {
    const directory = directoryWithSample();
    mkdirSync(join(directory, ".hull"));
    writeFileSync(stateFile(directory), JSON.stringify({ stateBucket }));
    const engine = fakeEngine();
    const provider = fakeProvider({ existingBuckets: [stateBucket] });

    await expect(runDestroy(directory, { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      `no .hull/passphrase, but .hull/state.json records the state bucket ${stateBucket}: this environment was deployed before and its state is locked with that passphrase. Copy .hull/passphrase from the machine that first deployed; Hull never regenerates it.`,
    );

    expect(provider.calls).toEqual([]);
    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
    expect(existsSync(passphraseFile(directory))).toBe(false);
  });

  it("reports the missing Pulumi CLI before anything else", async () => {
    const engine = fakeEngine({ cliMissing: true });
    const provider = fakeProvider();

    await expect(runDestroy(deployedDirectory(), { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      "the Pulumi CLI is not usable (not found in PATH); if it is missing, install it",
    );

    expect(provider.calls).toEqual([]);
  });

  it("reports an invalid blueprint with its diagnostics and makes no cloud call", async () => {
    const directory = deployedDirectory();
    writeFileSync(join(directory, "hull.yaml"), sampleBlueprint.replace("lambda-api-gateway", "fargate-api"));
    const provider = fakeProvider();

    await expect(runDestroy(directory, { provider: provider.provider })).rejects.toThrow(
      /hull\.yaml is not valid:\n  intents\.api\.resolution: "fargate-api" is not a candidate resolution/,
    );

    expect(provider.calls).toEqual([]);
  });

  it("does not need the entry file: the code is gone with the stack", async () => {
    const directory = deployedDirectory();
    writeFileSync(join(directory, "src", "api", "index.ts"), "");
    const { calls, engine } = fakeEngine();

    await runDestroy(directory, { engine });

    expect(calls.map((call) => call.method)).toEqual(["check", "destroy", "removeStack"]);
  });

  it("reports missing credentials and calls nothing else", async () => {
    const engine = fakeEngine();

    await expect(runDestroy(deployedDirectory(), { engine: engine.engine, provider: fakeProvider({ noCredentials: true }).provider })).rejects.toThrow(
      'no AWS credentials found for profile "sandbox" in region us-east-1',
    );

    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
  });

  it("refuses to destroy without a blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-cli-"));

    await expect(runDestroy(directory)).rejects.toThrow(`no hull.yaml in ${directory}; run \`hull init\` first`);
  });
});
