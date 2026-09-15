import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { LoadResult } from "@hull/blueprint";
import { blueprintSchemaUrl } from "@hull/blueprint";
import { describe, expect, it, vi } from "vitest";
import { createStudioServer, type ErrorResponse, type EstimateResponse } from "./index.js";
import { renderTemplate } from "./templates.js";

// POST /blueprint with a template name: the start screen's way of writing
// the first hull.yaml, in canonical form with the schema comment lines, plus
// the .gitignore entries, through the server like every other change. Refused
// when the file exists.

function emptyDirectory() {
  return mkdtempSync(join(tmpdir(), "hull-create-"));
}

async function create(directory: string, body: unknown, onWrite?: (blueprint: unknown) => void) {
  const app = createStudioServer({ directory, onWrite });
  const response = await app.request("/blueprint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { app, status: response.status, body: (await response.json()) as LoadResult & ErrorResponse };
}

describe("POST /blueprint", () => {
  it("writes the api-database template byte for byte as hull init does, with the .gitignore entries", async () => {
    const directory = emptyDirectory();

    const { status, body } = await create(directory, { template: "api-database" });

    expect(status).toBe(201);
    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint?.name).toBe("todos");
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toBe(
      renderTemplate("api-database", { schemaUrl: blueprintSchemaUrl.href, applicationName: basename(directory) }),
    );
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toContain("  api:\n    kind: http-api\n    resolution: lambda-api-gateway\n");
    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(
      "# Hull: generated bindings and the deploy secrets passphrase\n.hull/bindings/\n.hull/passphrase\n",
    );
  });

  it("writes a blank blueprint named after the folder, which loads without diagnostics and estimates to zero", async () => {
    const directory = emptyDirectory();

    const { app, status, body } = await create(directory, { template: "blank" });

    expect(status).toBe(201);
    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint).toEqual({
      name: basename(directory),
      provider: "aws",
      region: "us-east-1",
      usage: { requestsPerMonth: 100000, storageGb: 1 },
      intents: {},
      environments: { dev: {} },
    });
    const written = readFileSync(join(directory, "hull.yaml"), "utf8");
    expect(written.split("\n").slice(0, 2)).toEqual([`# $schema: ${blueprintSchemaUrl.href}`, `# yaml-language-server: $schema=${blueprintSchemaUrl.href}`]);
    const estimate = (await (await app.request("/estimate?environment=dev")).json()) as EstimateResponse;
    expect(estimate.intents).toEqual({});
    expect(estimate.total).toEqual({ withoutFreeTier: { low: 0, expected: 0, high: 0 }, withFreeTier: { low: 0, expected: 0, high: 0 } });
  });

  it("hands the new model to onWrite, so the bindings exist from the first save", async () => {
    const onWrite = vi.fn();

    await create(emptyDirectory(), { template: "api-database" }, onWrite);

    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite.mock.calls[0]?.[0]).toMatchObject({ name: "todos" });
  });

  it("is refused with 409 when the file exists, and leaves it untouched", async () => {
    const directory = emptyDirectory();
    writeFileSync(join(directory, "hull.yaml"), "name: mine\n");

    const { status, body } = await create(directory, { template: "api-database" });

    expect(status).toBe(409);
    expect(body).toEqual({ error: `hull.yaml already exists in ${directory}; remove it first to start over` });
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toBe("name: mine\n");
    expect(existsSync(join(directory, ".gitignore"))).toBe(false);
  });

  it("refuses an unknown template, naming the templates", async () => {
    const directory = emptyDirectory();

    const { status, body } = await create(directory, { template: "microservices" });

    expect(status).toBe(400);
    expect(body).toEqual({ error: '"microservices" is not a template; templates are api-database, blank' });
    expect(existsSync(join(directory, "hull.yaml"))).toBe(false);
  });

  it("refuses a body without a template name", async () => {
    const { status, body } = await create(emptyDirectory(), { name: "x" });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "body must name a template: api-database, blank" });
  });
});

describe("GET /templates", () => {
  it("lists the templates with what each writes", async () => {
    const response = await createStudioServer({ directory: emptyDirectory() }).request("/templates");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { name: "api-database", description: "an HTTP API on lambda-api-gateway linked read-write to a relational database on rds-postgres" },
      { name: "blank", description: "a blueprint named after this folder, on aws in us-east-1, with no intents and a dev environment" },
    ]);
  });
});
