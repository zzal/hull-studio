import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Blueprint } from "@hull/blueprint";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingsDirectory, generateBindings, generatedHeader, writeBindings } from "./bindings.js";
import { CompileError } from "./errors.js";

// Seam: the binding module a tier gets for the intents it is linked to. The
// module's shape is checked on its source; its behaviour by importing the
// module written for the sample blueprint, with the AWS SDK stubbed.

const sample: Blueprint = {
  name: "todos",
  provider: "aws",
  region: "us-east-1",
  usage: { requestsPerMonth: 100000, storageGb: 1 },
  intents: {
    api: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/api/index.ts", links: [{ to: "db", role: "read-write" }] },
    db: { kind: "relational-database", resolution: "rds-postgres" },
  },
  environments: { dev: {} },
};

const exportsOf = (source: string) => [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]);

describe("generateBindings", () => {
  it("exports db with connectionString() and no other intent for the sample blueprint", () => {
    const files = generateBindings(sample);

    expect(Object.keys(files)).toEqual(["index.ts"]);
    const source = files["index.ts"]!;
    expect(exportsOf(source)).toEqual(["db"]);
    expect(source).toContain("connectionString()");
    expect(source).toContain('"HULL_DB_HOST"');
    expect(source).toContain('"HULL_DB_PASSWORD_ARN"');
  });

  it("starts every file with the generated, do not edit header", () => {
    for (const source of Object.values(generateBindings(sample))) {
      expect(source.startsWith(generatedHeader)).toBe(true);
      expect(generatedHeader).toMatch(/generated/i);
      expect(generatedHeader).toMatch(/do not edit/i);
    }
  });

  it("exports nothing for a blueprint without links", () => {
    const unlinked: Blueprint = {
      ...sample,
      intents: { ...sample.intents, api: { ...sample.intents.api!, links: [] } as Blueprint["intents"][string] },
    };

    const source = generateBindings(unlinked)["index.ts"]!;

    expect(exportsOf(source)).toEqual([]);
    expect(source).toContain("export {}");
  });

  it("refuses a link to an intent that has no binding in this version", () => {
    const toTier: Blueprint = {
      ...sample,
      intents: {
        ...sample.intents,
        admin: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/admin.ts", links: [{ to: "api", role: "read-write" }] },
      },
    };

    expect(() => generateBindings(toTier)).toThrow(
      new CompileError('intent "admin" links to "api" of kind http-api, which has no binding in this version'),
    );
  });

  it("exports an intent once when two tiers link to it", () => {
    const twoTiers: Blueprint = {
      ...sample,
      intents: {
        ...sample.intents,
        admin: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/admin.ts", links: [{ to: "db", role: "read-write" }] },
      },
    };

    expect(exportsOf(generateBindings(twoTiers)["index.ts"]!)).toEqual(["db"]);
  });
});

// The stubbed Secrets Manager client: every `send` answers with the managed
// master password secret and is counted.
const send = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: { SecretId: string }) {}
  },
}));

// The module is written where this package would keep its own bindings, so
// its import of the AWS SDK resolves against this package's dependencies.
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-1";

describe("the binding module written for the sample blueprint", () => {
  beforeEach(() => {
    // Each test imports a fresh module: the cache under test lives in it.
    vi.resetModules();
    send.mockReset();
    send.mockResolvedValue({ SecretString: JSON.stringify({ username: "postgres", password: "p@ss/w:rd" }) });
    vi.stubEnv("HULL_DB_HOST", "db.internal");
    vi.stubEnv("HULL_DB_PORT", "5432");
    vi.stubEnv("HULL_DB_NAME", "todos");
    vi.stubEnv("HULL_DB_USER", "postgres");
    vi.stubEnv("HULL_DB_PASSWORD_ARN", secretArn);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(join(packageDirectory, ".hull"), { recursive: true, force: true });
  });

  async function importWritten() {
    const [written] = writeBindings(packageDirectory, sample);
    expect(written).toBe(join(packageDirectory, bindingsDirectory, "index.ts"));
    expect(readFileSync(written!, "utf8")).toBe(generateBindings(sample)["index.ts"]);
    return import(/* @vite-ignore */ written!) as Promise<{ db: { connectionString(): Promise<string> } }>;
  }

  it("fetches the secret once across repeated connectionString() calls and returns a Postgres URL", async () => {
    const { db } = await importWritten();

    const [first, second] = await Promise.all([db.connectionString(), db.connectionString()]);
    const third = await db.connectionString();

    expect(first).toBe("postgresql://postgres:p%40ss%2Fw%3Ard@db.internal:5432/todos?sslmode=require");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { SecretId: secretArn } });
  });

  it("names the missing contract variable", async () => {
    vi.stubEnv("HULL_DB_PASSWORD_ARN", "");
    const { db } = await importWritten();

    await expect(db.connectionString()).rejects.toThrow(
      "HULL_DB_PASSWORD_ARN is not set; the db binding only works inside a tier deployed by Hull with a link to db",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("retries the fetch after a failure instead of caching it", async () => {
    send.mockRejectedValueOnce(new Error("throttled"));
    const { db } = await importWritten();

    await expect(db.connectionString()).rejects.toThrow("throttled");
    await expect(db.connectionString()).resolves.toMatch(/^postgresql:\/\//);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
