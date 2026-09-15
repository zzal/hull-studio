import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadResult } from "@hull/blueprint";
import { describe, expect, it } from "vitest";
import { createStudioServer } from "./index.js";
import { demoBlueprint, get, sampleBlueprint as validBlueprint } from "./testing.js";

// GET /blueprint: the model and the validation diagnostics of hull.yaml.

const readBlueprint = (text: string) => get<LoadResult>(text, "/blueprint");

describe("GET /blueprint", () => {
  it("returns the model of a valid blueprint with no diagnostics", async () => {
    const { status, body } = await readBlueprint(validBlueprint);

    expect(status).toBe(200);
    expect(body).toEqual({
      blueprint: {
        name: "todos",
        provider: "aws",
        region: "us-east-1",
        usage: { requestsPerMonth: 100000, storageGb: 1 },
        intents: {
          api: {
            kind: "http-api",
            resolution: "lambda-api-gateway",
            entry: "src/api/index.ts",
            links: [{ to: "db", role: "read-write" }],
          },
          db: { kind: "relational-database", resolution: "rds-postgres" },
        },
        environments: {
          dev: {},
          prod: {
            usage: { requestsPerMonth: 2000000 },
            overrides: { db: { instanceClass: "db.t4g.small" } },
          },
        },
      },
      diagnostics: [],
    });
  });
});

describe("GET /blueprint with a queue and a background worker", () => {
  it("loads the milestone 2 demo blueprint without diagnostics", async () => {
    const { status, body } = await readBlueprint(demoBlueprint);

    expect(status).toBe(200);
    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint?.usage).toEqual({ requestsPerMonth: 100000, storageGb: 1, messagesPerMonth: 100000 });
    expect(body.blueprint?.intents.jobs).toEqual({ kind: "queue", resolution: "sqs-standard" });
    expect(body.blueprint?.intents.worker).toEqual({
      kind: "background-worker",
      resolution: "lambda-worker",
      entry: "src/worker/index.ts",
      links: [
        { to: "jobs", role: "consume" },
        { to: "db", role: "read-write" },
      ],
    });
    expect(body.blueprint?.environments.prod).toEqual({
      usage: { requestsPerMonth: 2000000, messagesPerMonth: 2000000 },
      overrides: { db: { instanceClass: "db.t4g.small" }, worker: { maxConcurrency: 10 } },
    });
  });

  it("loads a milestone 1 blueprint unchanged: no messagesPerMonth appears", async () => {
    const { body } = await readBlueprint(validBlueprint);

    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint?.usage).toEqual({ requestsPerMonth: 100000, storageGb: 1 });
  });

  it("allows a queue nobody consumes yet", async () => {
    const noConsumer = demoBlueprint.replace("      - to: jobs\n        role: consume\n", "");

    const { body } = await readBlueprint(noConsumer);

    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint?.intents.worker).toMatchObject({ links: [{ to: "db", role: "read-write" }] });
  });

  it("refuses two tiers consuming the same queue, naming both", async () => {
    const twoConsumers = demoBlueprint.replace(
      "      - to: jobs\n        role: produce\n",
      "      - to: jobs\n        role: consume\n",
    );

    const { body } = await readBlueprint(twoConsumers);

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "worker", "links", 0, "role"],
        message: 'queue "jobs" is consumed by both "api" and "worker"; a queue has at most one consuming tier',
      },
    ]);
  });

  it("refuses a link to a tier, naming the kinds a link can target", async () => {
    const toTier = demoBlueprint.replace("      - to: jobs\n        role: produce\n", "      - to: worker\n        role: produce\n");

    const { body } = await readBlueprint(toTier);

    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "api", "links", 1, "to"],
        message: '"worker" is of kind background-worker, which a link cannot target; a link targets an intent of kind relational-database, queue',
      },
    ]);
  });

  it("requires entry for a background-worker intent", async () => {
    const { body } = await readBlueprint(demoBlueprint.replace("    entry: src/worker/index.ts\n", ""));

    expect(body.diagnostics).toEqual([
      { path: ["intents", "worker", "entry"], message: "entry is required for a background-worker intent" },
    ]);
  });

  it("refuses produce on a database and read-write on a queue, naming each kind's roles", async () => {
    const { body } = await readBlueprint(
      demoBlueprint.replace("      - to: db\n        role: read-write\n      - to: jobs\n        role: produce\n", "      - to: db\n        role: produce\n      - to: jobs\n        role: read-write\n"),
    );

    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "api", "links", 0, "role"],
        message: '"produce" is not a link role of kind relational-database; link roles are read-write',
      },
      {
        path: ["intents", "api", "links", 1, "role"],
        message: '"read-write" is not a link role of kind queue; link roles are produce, consume',
      },
    ]);
  });

  it("refuses a negative messagesPerMonth", async () => {
    const { body } = await readBlueprint(demoBlueprint.replace("messagesPerMonth: 100000", "messagesPerMonth: -1"));

    expect(body.diagnostics).toEqual([{ path: ["usage", "messagesPerMonth"], message: "Too small: expected number to be >=0" }]);
  });
});

describe("GET /blueprint diagnostics", () => {
  it("rejects a resolution that is not a candidate for its kind on the provider", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("rds-postgres", "lambda-api-gateway"));

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "db", "resolution"],
        message:
          '"lambda-api-gateway" is not a candidate resolution of kind relational-database on provider aws; candidate resolutions are rds-postgres',
      },
    ]);
  });

  it("rejects an environment that declares a kind or a resolution", async () => {
    const { body } = await readBlueprint(
      validBlueprint.replace("  prod:\n", "  prod:\n    kind: http-api\n    resolution: rds-postgres\n"),
    );

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["environments", "prod", "kind"],
        message: 'unexpected key "kind", "resolution"; allowed keys are usage, policies, overrides',
      },
      {
        path: ["environments", "prod", "resolution"],
        message: 'unexpected key "kind", "resolution"; allowed keys are usage, policies, overrides',
      },
    ]);
  });

  it("rejects an override key that is not a sizing parameter of the intent's resolution", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("instanceClass", "instanceType"));

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["environments", "prod", "overrides", "db", "instanceType"],
        message:
          '"instanceType" is not a sizing parameter of resolution rds-postgres; sizing parameters are instanceClass, storageGb, multiAz',
      },
    ]);
  });

  it("rejects an override whose value is not the shape its sizing parameter takes", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("instanceClass: db.t4g.small", "multiAz: yes"));

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["environments", "prod", "overrides", "db", "multiAz"],
        message: 'sizing parameter multiAz of resolution rds-postgres takes a boolean, not "yes"',
      },
    ]);
  });

  it("rejects an override for an intent the blueprint does not declare", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("      db:\n        instanceClass", "      cache:\n        instanceClass"));

    expect(body.diagnostics).toEqual([
      {
        path: ["environments", "prod", "overrides", "cache"],
        message: '"cache" is not an intent of this blueprint; intents are api, db',
      },
    ]);
  });

  it("rejects a link to a tier", async () => {
    const { body } = await readBlueprint(
      validBlueprint.replace(
        "  db:\n",
        "  admin:\n    kind: http-api\n    resolution: lambda-api-gateway\n    entry: src/admin.ts\n    links:\n      - to: api\n        role: read-write\n\n  db:\n",
      ),
    );

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "admin", "links", 0, "to"],
        message: '"api" is of kind http-api, which a link cannot target; a link targets an intent of kind relational-database, queue',
      },
    ]);
  });

  it("rejects a link role the catalog does not define for the target kind", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("role: read-write", "role: admin"));

    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "api", "links", 0, "role"],
        message: '"admin" is not a link role of kind relational-database; link roles are read-write',
      },
    ]);
  });

  it("rejects a link to an intent the blueprint does not declare", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("to: db", "to: cache"));

    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "api", "links", 0, "to"],
        message: '"cache" is not an intent of this blueprint; intents are api, db',
      },
    ]);
  });

  it("requires entry for an http-api intent", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("    entry: src/api/index.ts\n", ""));

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      { path: ["intents", "api", "entry"], message: "entry is required for an http-api intent" },
    ]);
  });

  it("rejects an intent kind outside Hull's vocabulary", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("kind: relational-database", "kind: database"));

    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "db", "kind"],
        message: "Invalid discriminator value. Expected 'http-api' | 'relational-database' | 'queue' | 'background-worker'",
      },
    ]);
  });

  it("reports every vocabulary violation at once", async () => {
    const { body } = await readBlueprint(
      validBlueprint.replace("to: db", "to: cache").replace("instanceClass", "instanceType"),
    );

    expect(body.diagnostics.map((d) => d.path)).toEqual([
      ["intents", "api", "links", 0, "to"],
      ["environments", "prod", "overrides", "db", "instanceType"],
    ]);
  });

  it("reports a YAML syntax error with no model", async () => {
    const { status, body } = await readBlueprint("name: todos\nintents: [\n");

    expect(status).toBe(200);
    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0]?.path).toEqual([]);
    expect(body.diagnostics[0]?.message).toContain("line 3, column 1");
  });

  it("answers 404 when the directory has no blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
    const response = await createStudioServer({ directory }).request("/blueprint");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `no hull.yaml in ${directory}` });
  });
});
