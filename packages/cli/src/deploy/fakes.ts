import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import type { DeployEngine, ProgressEvent, ProviderAccount, StackTarget } from "./engine.js";
import { createHull } from "../index.js";
import { passphraseFileName, stateFileName } from "./state.js";

// Test doubles shared by the deploy and destroy tests: a directory holding
// the sample blueprint, a deploy engine that records what reaches it and
// answers with the events it is given, a provider account with the state
// buckets it is given, and a runner for the commands against them. No AWS,
// no Pulumi. Excluded from the build (tsconfig.build.json) with the tests
// that use it.

export const sampleBlueprint = `name: todos
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

// The milestone 2 plan's demo blueprint: the sample plus a queue produced by
// the API and consumed by a worker that also reads the database, and a prod
// environment with its own sizing.
export const demoBlueprint = `name: todos
provider: aws
region: us-east-1
usage:
  requestsPerMonth: 100000
  storageGb: 1
  messagesPerMonth: 100000
intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
      - to: db
        role: read-write
      - to: jobs
        role: produce
  jobs:
    kind: queue
    resolution: sqs-standard
  worker:
    kind: background-worker
    resolution: lambda-worker
    entry: src/worker/index.ts
    links:
      - to: jobs
        role: consume
      - to: db
        role: read-write
  db:
    kind: relational-database
    resolution: rds-postgres
environments:
  dev: {}
  prod:
    usage:
      requestsPerMonth: 2000000
      messagesPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
      worker:
        maxConcurrency: 10
`;

export const account = "123456789012";
export const stateBucket = `hull-state-${account}-us-east-1`;
export const apiUrl = "https://abc.execute-api.us-east-1.amazonaws.com";

const handlerSource = "export const handler = async () => ({ statusCode: 200 });\n";

export function directoryWithSample({ entry = true, blueprint = sampleBlueprint, workerEntry = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hull-cli-"));
  writeFileSync(join(directory, "hull.yaml"), blueprint);
  if (entry) {
    mkdirSync(join(directory, "src", "api"), { recursive: true });
    writeFileSync(join(directory, "src", "api", "index.ts"), handlerSource);
  }
  if (workerEntry && blueprint.includes("src/worker/index.ts")) {
    mkdirSync(join(directory, "src", "worker"), { recursive: true });
    writeFileSync(join(directory, "src", "worker", "index.ts"), handlerSource);
  }
  return directory;
}

export const passphraseFile = (directory: string) => join(directory, passphraseFileName);
export const stateFile = (directory: string) => join(directory, stateFileName);

// A directory the sample was deployed from, as deploy leaves it: the state
// file recording the bucket and the passphrase beside it.
export function deployedDirectory(passphrase = "p".repeat(43)) {
  const directory = directoryWithSample();
  mkdirSync(join(directory, ".hull"));
  writeFileSync(stateFile(directory), JSON.stringify({ stateBucket }));
  writeFileSync(passphraseFile(directory), passphrase, { mode: 0o600 });
  return directory;
}

type EngineCall = { method: string; target?: StackTarget; program?: unknown };

type FakeEngineOptions = {
  // Played back by `preview`, with the change counts it then answers.
  previewEvents?: ProgressEvent[];
  previewChanges?: Record<string, number>;
  // Played back by `up`.
  upEvents?: ProgressEvent[];
  // Played back by `destroy`.
  destroyEvents?: ProgressEvent[];
  outputs?: Record<string, unknown>;
  cliMissing?: boolean;
  // Thrown by `up` and `destroy` after their events, as the engine does
  // when an operation failed.
  fails?: string;
};

export function fakeEngine({
  previewEvents = [],
  previewChanges = {},
  upEvents = [],
  destroyEvents = [],
  outputs = { apiUrl },
  cliMissing = false,
  fails,
}: FakeEngineOptions = {}) {
  const calls: EngineCall[] = [];
  const engine: DeployEngine = {
    async check() {
      calls.push({ method: "check" });
      if (cliMissing) throw new Error("the Pulumi CLI is not usable (not found in PATH); if it is missing, install it");
    },
    async preview(target, program, onEvent) {
      calls.push({ method: "preview", target, program });
      for (const event of previewEvents) onEvent(event);
      return { changes: previewChanges };
    },
    async up(target, program, onEvent) {
      calls.push({ method: "up", target, program });
      for (const event of upEvents) onEvent(event);
      if (fails) throw new Error(fails);
      return outputs;
    },
    async destroy(target, onEvent) {
      calls.push({ method: "destroy", target });
      for (const event of destroyEvents) onEvent(event);
      if (fails) throw new Error(fails);
    },
    async removeStack(target) {
      calls.push({ method: "removeStack", target });
    },
  };
  return { calls, engine };
}

type ProviderCall = { method: string; args: unknown[] };

export function fakeProvider({ existingBuckets = [] as string[], noCredentials = false } = {}) {
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

type Fakes = {
  engine?: DeployEngine;
  provider?: ProviderAccount;
  args?: string[];
  // Receives the printed lines as they come, for a run expected to fail.
  lines?: string[];
  // Answers the deploy confirmation; absent means a non-interactive run.
  confirm?: (question: string) => Promise<boolean>;
};

// Runs one command in the directory against the fakes and returns what it
// printed. A deploy passes --yes unless the test answers the question itself.
export async function runHull(
  directory: string,
  command: "deploy" | "destroy" | "plan",
  { engine = fakeEngine().engine, provider = fakeProvider().provider, args, lines = [], confirm }: Fakes = {},
) {
  const rawArgs = args ?? (command === "deploy" && !confirm ? ["--env", "dev", "--yes"] : ["--env", "dev"]);
  await runCommand(
    createHull({
      cwd: directory,
      output: (line) => lines.push(line),
      openBrowser: async () => {
        throw new Error(`${command} must not open a browser`);
      },
      engine,
      provider,
      confirm,
    }),
    { rawArgs: [command, ...rawArgs] },
  );
  return lines;
}
