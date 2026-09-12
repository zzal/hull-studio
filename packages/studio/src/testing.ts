import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "./server.js";

// Seam 1 from the milestone 1 spec: the studio HTTP API over a temporary
// directory holding a blueprint, called in-process. Shared by the route tests;
// excluded from the package build.

// The milestone 1 plan's sample blueprint, as `hull init` writes it minus the
// schema comment lines.
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
  prod:
    usage:
      requestsPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
`;

// A studio server over a fresh temporary directory holding `text` as hull.yaml.
export function studioOver(text: string) {
  const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
  writeFileSync(join(directory, "hull.yaml"), text);
  return createStudioServer({ directory });
}

export async function get<T>(text: string, path: string) {
  const response = await studioOver(text).request(path);
  return { status: response.status, body: (await response.json()) as T };
}
