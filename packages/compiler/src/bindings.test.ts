import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// The milestone 2 plan's demo blueprint: the API produces to the queue the
// worker consumes, and both read the database.
const demo: Blueprint = {
  ...sample,
  usage: { requestsPerMonth: 100000, storageGb: 1, messagesPerMonth: 100000 },
  intents: {
    api: {
      kind: "http-api",
      resolution: "lambda-api-gateway",
      entry: "src/api/index.ts",
      links: [
        { to: "db", role: "read-write" },
        { to: "jobs", role: "produce" },
      ],
    },
    jobs: { kind: "queue", resolution: "sqs-standard" },
    worker: {
      kind: "background-worker",
      resolution: "lambda-worker",
      entry: "src/worker/index.ts",
      links: [
        { to: "jobs", role: "consume" },
        { to: "db", role: "read-write" },
      ],
    },
    db: { kind: "relational-database", resolution: "rds-postgres" },
  },
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

  it("exports jobs with send and consume, and db, for the demo blueprint", () => {
    const source = generateBindings(demo)["index.ts"]!;

    expect(exportsOf(source)).toEqual(["db", "jobs"]);
    expect(source).toContain('export const jobs: Pick<QueueBinding, "send" | "consume">');
    expect(source).toContain('"HULL_JOBS_URL"');
    expect(source).toContain("@aws-sdk/client-sqs");
  });

  it("exports only the methods of the roles linked to a queue", () => {
    const produceOnly: Blueprint = { ...demo, intents: { ...demo.intents, worker: { ...demo.intents.worker!, links: [{ to: "db", role: "read-write" }] } as Blueprint["intents"][string] } };

    expect(generateBindings(produceOnly)["index.ts"]).toContain('export const jobs: Pick<QueueBinding, "send">');
  });

  it("imports the SQS client only when a queue is linked", () => {
    expect(generateBindings(sample)["index.ts"]).not.toContain("@aws-sdk/client-sqs");
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

// The stubbed SQS client: every `send` is counted with its command, and the
// number of clients made is counted too.
const sqsSend = vi.fn();
let sqsClients = 0;
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = sqsSend;
    constructor() {
      sqsClients++;
    }
  },
  SendMessageCommand: class {
    constructor(public readonly input: { QueueUrl: string; MessageBody: string }) {}
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

type SqsEvent = { Records: { messageId: string; body: string }[] };
type QueueBinding = {
  send(message: unknown): Promise<void>;
  consume<Message>(handler: (message: Message) => Promise<void>): (event: SqsEvent) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;
};

describe("the queue binding written for the demo blueprint", () => {
  const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/jobs";
  // Its own folder under the package, so the module resolves the SDK the
  // same way and never collides with the sample's module at the same path.
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(packageDirectory, "demo-bindings-"));
    vi.resetModules();
    sqsSend.mockReset();
    sqsSend.mockResolvedValue({});
    sqsClients = 0;
    vi.stubEnv("HULL_JOBS_URL", queueUrl);
    vi.stubEnv("HULL_JOBS_ARN", "arn:aws:sqs:us-east-1:123456789012:jobs");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  async function importWritten() {
    const [written] = writeBindings(directory, demo);
    return import(/* @vite-ignore */ written!) as Promise<{ jobs: QueueBinding }>;
  }

  it("send JSON-encodes the message to the queue named by the contract, with one client per process", async () => {
    const { jobs } = await importWritten();

    await jobs.send({ title: "Ship milestone 2" });
    await jobs.send({ title: "Again" });

    expect(sqsSend).toHaveBeenCalledTimes(2);
    expect(sqsSend.mock.calls[0]?.[0]).toMatchObject({ input: { QueueUrl: queueUrl, MessageBody: '{"title":"Ship milestone 2"}' } });
    expect(sqsClients).toBe(1);
  });

  it("send names the missing contract variable", async () => {
    vi.stubEnv("HULL_JOBS_URL", "");
    const { jobs } = await importWritten();

    await expect(jobs.send({})).rejects.toThrow("HULL_JOBS_URL is not set; the jobs binding only works inside a tier deployed by Hull with a link to jobs");
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("consume calls the handler once per decoded message and reports exactly the ids that threw", async () => {
    const { jobs } = await importWritten();
    const seen: unknown[] = [];
    const handler = jobs.consume<{ title: string }>(async (message) => {
      seen.push(message);
      if (message.title === "bad") throw new Error("cannot insert");
    });

    const result = await handler({
      Records: [
        { messageId: "m1", body: '{"title":"one"}' },
        { messageId: "m2", body: '{"title":"bad"}' },
        { messageId: "m3", body: "not json" },
        { messageId: "m4", body: '{"title":"four"}' },
      ],
    });

    expect(seen).toEqual([{ title: "one" }, { title: "bad" }, { title: "four" }]);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }] });
  });

  it("consume answers with no failures for a batch that all went through", async () => {
    const { jobs } = await importWritten();
    const handler = jobs.consume(async () => undefined);

    await expect(handler({ Records: [{ messageId: "m1", body: "{}" }] })).resolves.toEqual({ batchItemFailures: [] });
  });
});
