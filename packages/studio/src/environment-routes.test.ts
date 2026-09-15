import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStudioServer, type ErrorResponse } from "./index.js";
import { get, sampleBlueprint } from "./testing.js";

// Every route over one environment (`?environment=<name>`) answers the same
// way when there is nothing to compute: no name, an unknown name, an invalid
// blueprint, no blueprint at all.

describe.each(["/estimate", "/recommendations", "/catalog"])("GET %s over an environment", (route) => {
  const failing = (text: string, query: string) => get<ErrorResponse>(text, `${route}${query}`);

  it("requires an environment name", async () => {
    const { status, body } = await failing(sampleBlueprint, "");

    expect(status).toBe(400);
    expect(body).toEqual({ error: "environment query parameter is required" });
  });

  it("names the environments when asked for one the blueprint does not declare", async () => {
    const { status, body } = await failing(sampleBlueprint, "?environment=staging");

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'no environment "staging" in hull.yaml; environments are dev, prod' });
  });

  it("reports the diagnostics of an invalid blueprint instead of an answer", async () => {
    const { status, body } = await failing(
      sampleBlueprint.replace("instanceClass: db.t4g.small", "storageGb: plenty"),
      "?environment=prod",
    );

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "hull.yaml is not valid",
      diagnostics: [
        {
          path: ["environments", "prod", "overrides", "db", "storageGb"],
          message: 'sizing parameter storageGb of resolution rds-postgres takes a number, not "plenty"',
        },
      ],
    });
  });

  it("answers 404 when the directory has no blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
    const response = await createStudioServer({ directory }).request(`${route}?environment=dev`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `no hull.yaml in ${directory}` });
  });
});
