import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadResult } from "@hull/blueprint";
import { describe, expect, it } from "vitest";
import { createStudioServer } from "./index.js";

// Seam 1 from the milestone 1 spec: the studio HTTP API over a temporary
// directory holding a blueprint, called in-process.

const validBlueprint = `name: todos
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
  prod:
    usage:
      requestsPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
`;

async function readBlueprint(text: string) {
  const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
  writeFileSync(join(directory, "hull.yaml"), text);
  const response = await createStudioServer({ directory }).request("/blueprint");
  return { status: response.status, body: (await response.json()) as LoadResult };
}

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

  it("rejects an override for an intent the blueprint does not declare", async () => {
    const { body } = await readBlueprint(validBlueprint.replace("      db:\n        instanceClass", "      cache:\n        instanceClass"));

    expect(body.diagnostics).toEqual([
      {
        path: ["environments", "prod", "overrides", "cache"],
        message: '"cache" is not an intent of this blueprint; intents are api, db',
      },
    ]);
  });

  it("rejects a link role the target intent's kind does not accept", async () => {
    const { body } = await readBlueprint(
      validBlueprint.replace(
        "  db:\n",
        "  admin:\n    kind: http-api\n    resolution: lambda-api-gateway\n    entry: src/admin.ts\n    links:\n      - to: api\n        role: read-write\n\n  db:\n",
      ),
    );

    expect(body.blueprint).toBeNull();
    expect(body.diagnostics).toEqual([
      {
        path: ["intents", "admin", "links", 0, "role"],
        message: '"read-write" is not a link role of kind http-api; kind http-api has no link roles',
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
        message: "Invalid discriminator value. Expected 'http-api' | 'relational-database'",
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
