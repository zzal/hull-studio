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

export const account = "123456789012";
export const stateBucket = `hull-state-${account}-us-east-1`;
export const apiUrl = "https://abc.execute-api.us-east-1.amazonaws.com";

export function directoryWithSample({ entry = true, blueprint = sampleBlueprint } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hull-cli-"));
  writeFileSync(join(directory, "hull.yaml"), blueprint);
  if (entry) {
    mkdirSync(join(directory, "src", "api"), { recursive: true });
    writeFileSync(join(directory, "src", "api", "index.ts"), "export const handler = async () => ({ statusCode: 200 });\n");
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
  // Played back by `up`.
  upEvents?: ProgressEvent[];
  // Played back by `destroy`.
  destroyEvents?: ProgressEvent[];
  outputs?: Record<string, unknown>;
  cliMissing?: boolean;
};

export function fakeEngine({ upEvents = [], destroyEvents = [], outputs = { apiUrl }, cliMissing = false }: FakeEngineOptions = {}) {
  const calls: EngineCall[] = [];
  const engine: DeployEngine = {
    async check() {
      calls.push({ method: "check" });
      if (cliMissing) throw new Error("the Pulumi CLI is not usable (not found in PATH); if it is missing, install it");
    },
    async up(target, program, onEvent) {
      calls.push({ method: "up", target, program });
      for (const event of upEvents) onEvent(event);
      return outputs;
    },
    async destroy(target, onEvent) {
      calls.push({ method: "destroy", target });
      for (const event of destroyEvents) onEvent(event);
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

type Fakes = { engine?: DeployEngine; provider?: ProviderAccount; args?: string[] };

// Runs one command in the directory against the fakes and returns what it
// printed.
export async function runHull(
  directory: string,
  command: "deploy" | "destroy",
  { engine = fakeEngine().engine, provider = fakeProvider().provider, args = ["--env", "dev"] }: Fakes = {},
) {
  const lines: string[] = [];
  await runCommand(
    createHull({
      cwd: directory,
      output: (line) => lines.push(line),
      openBrowser: async () => {
        throw new Error(`${command} must not open a browser`);
      },
      engine,
      provider,
    }),
    { rawArgs: [command, ...args] },
  );
  return lines;
}
