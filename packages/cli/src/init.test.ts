import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStudioServer } from "@hull/studio";
import { runCommand } from "citty";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { createHull } from "./index.js";

// Seam 2 from the milestone 1 spec: the CLI run in a temporary directory,
// checked by the files it writes.

const schemaUrl = pathToFileURL(resolve(import.meta.dirname, "../../blueprint/schema/v0/hull.json")).href;

// The plan's sample blueprint (docs/milestones/01-proof-of-concept.md) in
// canonical form, with the schema comments pointing at the committed schema.
const expectedBlueprint = `# $schema: ${schemaUrl}
# yaml-language-server: $schema=${schemaUrl}

name: todos
provider: aws
region: us-east-1

usage:
  # usage profile, low-end defaults from \`hull init\`
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

const neverOpens = async () => {
  throw new Error("init must not open a browser");
};

async function runInit(directory: string) {
  const lines: string[] = [];
  await runCommand(createHull({ cwd: directory, output: (line) => lines.push(line), openBrowser: neverOpens }), {
    rawArgs: ["init"],
  });
  return lines;
}

describe("hull init", () => {
  it("writes the sample blueprint in canonical form with both schema comment lines", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));

    await runInit(directory);

    const written = readFileSync(join(directory, "hull.yaml"), "utf8");
    expect(written).toBe(expectedBlueprint);
    expect(parseDocument(written).toString()).toBe(written);
  });

  it("writes a blueprint the studio loads without diagnostics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));

    await runInit(directory);

    const response = await createStudioServer({ directory }).request("/blueprint");
    const body = (await response.json()) as { blueprint: unknown; diagnostics: unknown[] };
    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint).not.toBeNull();
  });

  it("creates a .gitignore with the bindings folder and the passphrase file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));

    await runInit(directory);

    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(
      "# Hull: generated bindings and the deploy secrets passphrase\n.hull/bindings/\n.hull/passphrase\n",
    );
  });

  it("appends the entries to an existing .gitignore and keeps its content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n");

    await runInit(directory);

    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(
      "node_modules/\n\n# Hull: generated bindings and the deploy secrets passphrase\n.hull/bindings/\n.hull/passphrase\n",
    );
  });

  it("leaves a .gitignore that already has the entries untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));
    const existing = "node_modules/\n.hull/bindings/\n.hull/passphrase\n";
    writeFileSync(join(directory, ".gitignore"), existing);

    await runInit(directory);

    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(existing);
  });

  it("refuses to overwrite an existing hull.yaml", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));
    writeFileSync(join(directory, "hull.yaml"), "name: mine\n");

    await expect(runInit(directory)).rejects.toThrow(
      `hull.yaml already exists in ${directory}; remove it first to start over`,
    );

    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toBe("name: mine\n");
    expect(existsSync(join(directory, ".gitignore"))).toBe(false);
  });

  it("tells the developer what it wrote and what to run next", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-init-"));

    const lines = await runInit(directory);

    expect(lines).toEqual([
      "Wrote hull.yaml: an HTTP API on lambda-api-gateway linked read-write to a relational database on rds-postgres.",
      "Added .hull/bindings/ and .hull/passphrase to .gitignore.",
      "Next: run `hull studio` to see the estimate and the recommendation.",
    ]);
  });
});
