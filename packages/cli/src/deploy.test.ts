import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { describe, expect, it } from "vitest";
import type { DeployEngine, ProgressEvent, ProviderAccount, StackTarget } from "./deploy/engine.js";
import { passphraseFileName, stateFileName } from "./deploy/state.js";
import { createHull } from "./index.js";
// The command loads the compiler, and with it Pulumi's SDK, on first use;
// loaded here so that time is not charged to the first test.
import "@hull/compiler";

// Seam 2 from the milestone 1 spec: `hull deploy --env dev` run in a
// temporary directory against a fake deploy engine and a fake provider account,
// checked by the state file, the passphrase file, what reaches the engine,
// and the lines rendered from synthetic progress events. No AWS, no Pulumi.

const sampleBlueprint = `name: todos
provider: aws
region: us-east-1
usage:
  requestsPerMonth: 100000
  storageGb: 1
intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
      - to: db
        role: read-write
  db:
    kind: relational-database
    resolution: rds-postgres
environments:
  dev: {}
`;

const account = "123456789012";
const stateBucket = `hull-state-${account}-us-east-1`;
const apiUrl = "https://abc.execute-api.us-east-1.amazonaws.com";

function directoryWithSample({ entry = true, blueprint = sampleBlueprint } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hull-deploy-"));
  writeFileSync(join(directory, "hull.yaml"), blueprint);
  if (entry) {
    mkdirSync(join(directory, "src", "api"), { recursive: true });
    writeFileSync(join(directory, "src", "api", "index.ts"), "export const handler = async () => ({ statusCode: 200 });\n");
  }
  return directory;
}

type EngineCall = { method: string; target?: StackTarget; program?: unknown };

// An engine that answers `up` with the events and outputs it is given.
function fakeEngine({ events = [] as ProgressEvent[], outputs = { apiUrl } as Record<string, unknown>, cliMissing = false } = {}) {
  const calls: EngineCall[] = [];
  const engine: DeployEngine = {
    async check() {
      calls.push({ method: "check" });
      if (cliMissing) throw new Error("the Pulumi CLI is not usable (not found in PATH); if it is missing, install it");
    },
    async up(target, program, onEvent) {
      calls.push({ method: "up", target, program });
      for (const event of events) onEvent(event);
      return outputs;
    },
    async destroy(target) {
      calls.push({ method: "destroy", target });
    },
    async removeStack(target) {
      calls.push({ method: "removeStack", target });
    },
  };
  return { calls, engine };
}

type ProviderCall = { method: string; args: unknown[] };

// An account on the provider with the state buckets it is given.
function fakeProvider({ existingBuckets = [] as string[], noCredentials = false } = {}) {
  const calls: ProviderCall[] = [];
  const buckets = new Set(existingBuckets);
  const provider: ProviderAccount = {
    async identity(region) {
      calls.push({ method: "identity", args: [region] });
      if (noCredentials) throw new Error(`no AWS credentials found for profile "sandbox" in region ${region}`);
      return { account, profile: "sandbox" };
    },
    async ensureStateBucket(name, region) {
      calls.push({ method: "ensureStateBucket", args: [name, region] });
      if (buckets.has(name)) return "existed";
      buckets.add(name);
      return "created";
    },
  };
  return { calls, provider };
}

type Fakes = { engine?: DeployEngine; provider?: ProviderAccount; args?: string[] };

async function runDeploy(directory: string, { engine = fakeEngine().engine, provider = fakeProvider().provider, args = ["--env", "dev"] }: Fakes = {}) {
  const lines: string[] = [];
  await runCommand(
    createHull({
      cwd: directory,
      output: (line) => lines.push(line),
      openBrowser: async () => {
        throw new Error("deploy must not open a browser");
      },
      engine,
      provider,
    }),
    { rawArgs: ["deploy", ...args] },
  );
  return lines;
}

const passphraseFile = (directory: string) => join(directory, passphraseFileName);
const stateFile = (directory: string) => join(directory, stateFileName);

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
      events: [
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
    const directory = mkdtempSync(join(tmpdir(), "hull-deploy-"));

    await expect(runDeploy(directory)).rejects.toThrow(`no hull.yaml in ${directory}; run \`hull init\` first`);
  });
});
