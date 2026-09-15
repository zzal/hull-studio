import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { account, directoryWithSample, fakeEngine, fakeProvider, passphraseFile, runHull, stateBucket, stateFile } from "./deploy/fakes.js";

// `hull plan --env dev`: the deploy pipeline stopped before any mutation of
// the environment. Pre-flight as deploy, the engine's preview rendered as
// one line per resource with its operation, the change counts, then the
// environment's expected monthly figure with and without free tier, from
// the estimate the studio serves. Never `up`.

const runPlan = (directory: string, fakes?: Parameters<typeof runHull>[2]) => runHull(directory, "plan", fakes);

describe("hull plan --env dev", () => {
  it("calls check and preview only, never up, on the environment's stack", async () => {
    const directory = directoryWithSample();
    const { calls, engine } = fakeEngine();

    await runPlan(directory, { engine });

    expect(calls.map((call) => call.method)).toEqual(["check", "preview"]);
    expect(calls[1]!.target).toMatchObject({ project: "todos", stack: "dev", backendUrl: `s3://${stateBucket}?region=us-east-1` });
    expect(typeof calls[1]!.program).toBe("function");
  });

  it("renders the resource lines, the change counts and the figure for the sample's dev environment", async () => {
    const directory = directoryWithSample();
    const { engine } = fakeEngine({
      previewEvents: [
        { phase: "done", operation: "create", type: "aws:ec2/securityGroup:SecurityGroup", name: "db" },
        { phase: "done", operation: "create", type: "aws:rds/instance:Instance", name: "db" },
        { phase: "done", operation: "update", type: "aws:lambda/function:Function", name: "api" },
        { phase: "done", operation: "same", type: "aws:cloudwatch/logGroup:LogGroup", name: "api" },
        { phase: "diagnostic", severity: "warning", message: "the default VPC has six subnets\n" },
      ],
      previewChanges: { create: 2, update: 1, same: 1 },
    });

    const lines = await runPlan(directory, { engine });

    expect(lines).toEqual([
      `Planning todos dev in us-east-1 (account ${account}, profile sandbox).`,
      `Created the state bucket ${stateBucket} and recorded it in .hull/state.json; commit that file.`,
      "Generated the deploy secrets passphrase in .hull/passphrase; keep it, it unlocks this environment's state.",
      "Wrote .hull/bindings/index.ts.",
      "Plan for todos dev:",
      "  create   aws:ec2/securityGroup:SecurityGroup  db",
      "  create   aws:rds/instance:Instance  db",
      "  update   aws:lambda/function:Function  api",
      "  warning: the default VPC has six subnets",
      "Changes: 2 to create, 1 to update, 1 unchanged.",
      "Expected monthly figure for dev: $14.58 (low $14.46, high $15.12), or $14.48 with always-free allowances only.",
      "Nothing was created; run `hull deploy --env dev` to proceed.",
    ]);
    expect(existsSync(stateFile(directory))).toBe(true);
    expect(readFileSync(passphraseFile(directory), "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("says when there is nothing to change", async () => {
    const lines = await runPlan(directoryWithSample(), { engine: fakeEngine({ previewChanges: { same: 14 } }).engine });

    expect(lines).toContain("Changes: 14 unchanged.");
  });

  it("runs the same pre-flight as deploy: a missing entry is reported before any cloud call", async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();

    await expect(runPlan(directoryWithSample({ entry: false }), { engine: engine.engine, provider: provider.provider })).rejects.toThrow(
      "no entry src/api/index.ts for intent api; hull.yaml points at a file that does not exist",
    );

    expect(provider.calls).toEqual([]);
    expect(engine.calls.map((call) => call.method)).toEqual(["check"]);
  });

  it("requires --env", async () => {
    await expect(runPlan(directoryWithSample(), { args: [] })).rejects.toThrow(/--env/);
  });
});
