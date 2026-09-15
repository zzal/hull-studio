import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadResult, Op } from "@hull/blueprint";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  addIntentEdit,
  addLinkEdit,
  environmentUsageEdit,
  overrideEdit,
  removeIntentEdit,
  removeLinkEdit,
  renameIntentEdit,
  resetOverrideEdit,
  usageEdit,
} from "./edits.js";
import type { CatalogResponse, ErrorResponse, EstimateResponse } from "./index.js";
import { renderTemplate } from "./templates.js";
import { comments, demoBlueprint, get, sampleBlueprint, studioDirectoryOver } from "./testing.js";

// The dashboard as a patch editor over the server: building the milestone 2
// demo blueprint from the api-database template one act at a time, each act
// one PUT, then taking it apart; and pinning and resetting overrides. The
// file is only ever touched by the server.

const schemaUrl = "file:///schema/v0/hull.json";

function editor(text: string) {
  const { app, directory } = studioDirectoryOver(text);
  const file = () => readFileSync(join(directory, "hull.yaml"), "utf8");
  const put = async (ops: Op[]) => {
    const response = await app.request("/blueprint", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ops) });
    return { status: response.status, body: (await response.json()) as LoadResult & ErrorResponse };
  };
  // Applies the operations, expecting the studio to accept them, and returns
  // the new model.
  const accept = async (ops: Op[]) => {
    const { status, body } = await put(ops);
    expect(body.diagnostics ?? [], body.error).toEqual([]);
    expect(status).toBe(200);
    return body.blueprint!;
  };
  return { app, file, put, accept };
}

describe("building the demo blueprint from the api-database template", () => {
  it("yields the demo file, comments intact, in canonical form", async () => {
    const template = renderTemplate("api-database", { schemaUrl, applicationName: "todos" });
    const { file, accept } = editor(template);

    let blueprint = await accept([usageEdit((await accept([])), "dev", "messagesPerMonth", 100000)]);
    blueprint = await accept([environmentUsageEdit("prod", "messagesPerMonth", 2000000)]);
    const queue = addIntentEdit(blueprint, "queue", "sqs-standard");
    blueprint = await accept([queue.op]);
    blueprint = await accept(renameIntentEdit(blueprint, queue.name, "jobs"));
    const worker = addIntentEdit(blueprint, "background-worker", "lambda-worker");
    blueprint = await accept([worker.op]);
    blueprint = await accept([addLinkEdit(blueprint, "api", "jobs", "produce")]);
    blueprint = await accept([addLinkEdit(blueprint, "worker", "jobs", "consume")]);
    blueprint = await accept([addLinkEdit(blueprint, "worker", "db", "read-write")]);
    blueprint = await accept([overrideEdit("prod", "worker", "maxConcurrency", 10)]);

    expect(file()).toBe(`# $schema: ${schemaUrl}
# yaml-language-server: $schema=${schemaUrl}

name: todos
provider: aws
region: us-east-1

usage:
  # usage profile, low-end defaults from \`hull init\`
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

  db:
    kind: relational-database
    resolution: rds-postgres

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
`);
    expect(comments(file())).toEqual(comments(template));
    expect(parseDocument(file()).toString()).toBe(file());
    // The same blueprint as the plan's, intents in the order they were added.
    const demo = (await get<LoadResult>(demoBlueprint, "/blueprint")).body.blueprint!;
    expect({ ...blueprint, intents: undefined }).toEqual({ ...demo, intents: undefined });
    expect(blueprint.intents).toEqual(demo.intents);
  });
});

describe("removing intents and links", () => {
  it("refuses to remove an intent a tier still links to, with the diagnostic, and leaves the file untouched", async () => {
    const { file, put } = editor(demoBlueprint);

    const { status, body } = await put(removeIntentEdit((await get<LoadResult>(demoBlueprint, "/blueprint")).body.blueprint!, "jobs"));

    expect(status).toBe(422);
    expect(body.diagnostics).toEqual([
      { path: ["intents", "api", "links", 1, "to"], message: '"jobs" is not an intent of this blueprint; intents are api, worker, db' },
      { path: ["intents", "worker", "links", 0, "to"], message: '"jobs" is not an intent of this blueprint; intents are api, worker, db' },
    ]);
    expect(file()).toBe(demoBlueprint);
  });

  it("removes the links first, then the intent, leaving no empty mappings or sequences", async () => {
    const { file, accept } = editor(demoBlueprint);
    let blueprint = (await get<LoadResult>(demoBlueprint, "/blueprint")).body.blueprint!;

    blueprint = await accept([removeLinkEdit("api", 1)]);
    blueprint = await accept([removeLinkEdit("worker", 0)]);
    blueprint = await accept(removeIntentEdit(blueprint, "jobs"));
    blueprint = await accept([removeLinkEdit("worker", 0)]);
    blueprint = await accept(removeIntentEdit(blueprint, "worker"));

    expect(Object.keys(blueprint.intents)).toEqual(["api", "db"]);
    expect(blueprint.environments.prod).toEqual({
      usage: { requestsPerMonth: 2000000, messagesPerMonth: 2000000 },
      overrides: { db: { instanceClass: "db.t4g.small" } },
    });
    expect(file()).not.toMatch(/links: \[\]|worker|jobs/);
    expect(parseDocument(file()).toString()).toBe(file());
  });
});

describe("overrides in the inspector", () => {
  const estimate = async (app: ReturnType<typeof editor>["app"], environment: string) =>
    (await (await app.request(`/estimate?environment=${environment}`)).json()) as EstimateResponse;

  it("pins db.instanceClass for dev, marks it overridden, and resetting removes the whole overrides mapping", async () => {
    const { app, file, accept } = editor(sampleBlueprint);

    await accept([overrideEdit("dev", "db", "instanceClass", "db.t4g.small")]);

    expect((await estimate(app, "dev")).intents.db?.sizing.instanceClass).toEqual({ value: "db.t4g.small", source: "overridden" });
    expect(file()).toContain("  dev:\n    overrides:\n      db:\n        instanceClass: db.t4g.small\n");

    await accept([resetOverrideEdit("dev", "db", "instanceClass")]);

    expect((await estimate(app, "dev")).intents.db?.sizing.instanceClass).toEqual({ value: "db.t4g.micro", source: "derived" });
    expect(file()).toBe(sampleBlueprint);
  });

  it("refuses an override outside the range the parameter accepts, with the estimate's message, file untouched", async () => {
    const { file, put } = editor(sampleBlueprint);

    const { status, body } = await put([overrideEdit("prod", "api", "memoryMb", 0)]);

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "sizing of lambda-api-gateway is not valid: memoryMb: Too small: expected number to be >0",
      diagnostics: [
        { path: ["environments", "prod", "overrides", "api"], message: "sizing of lambda-api-gateway is not valid: memoryMb: Too small: expected number to be >0" },
      ],
    });
    expect(file()).toBe(sampleBlueprint);
  });

  it("refuses an instance class the snapshot does not price, file untouched", async () => {
    const { file, put } = editor(sampleBlueprint);

    const { status, body } = await put([overrideEdit("prod", "db", "instanceClass", "db.r6g.large")]);

    expect(status).toBe(422);
    expect(body.error).toBe(
      'no price in the aws us-east-1 snapshot for RDS instance class "db.r6g.large"; priced classes are db.t4g.micro, db.t4g.small, db.t4g.medium',
    );
    expect(body.diagnostics?.[0]?.path).toEqual(["environments", "prod", "overrides", "db"]);
    expect(file()).toBe(sampleBlueprint);
  });
});

describe("GET /catalog", () => {
  it("lists every kind's roles, candidates with their resources and the priced choices, and the recommended candidate at the environment", async () => {
    const { status, body } = await get<CatalogResponse>(sampleBlueprint, "/catalog?environment=dev");

    expect(status).toBe(200);
    expect(body.provider).toBe("aws");
    expect(Object.keys(body.kinds)).toEqual(["http-api", "relational-database", "queue", "background-worker"]);
    expect(body.kinds["relational-database"]).toEqual({
      roles: ["read-write"],
      recommended: "rds-postgres",
      candidates: [
        {
          resolution: "rds-postgres",
          kind: "relational-database",
          deployable: true,
          resources: ["RDS instance", "gp3 storage", "security group", "managed master password secret"],
          sizingParameters: {
            instanceClass: { type: "string", choices: ["db.t4g.micro", "db.t4g.small", "db.t4g.medium"] },
            storageGb: { type: "number" },
            multiAz: { type: "boolean" },
          },
        },
      ],
    });
    expect(body.kinds["background-worker"]?.recommended).toBe("lambda-worker");
    expect(body.kinds["background-worker"]?.candidates.map((candidate) => [candidate.resolution, candidate.deployable])).toEqual([
      ["lambda-worker", true],
      ["fargate-worker", false],
    ]);
    expect(body.kinds.queue).toMatchObject({ roles: ["produce", "consume"], recommended: "sqs-standard" });
  });
});
