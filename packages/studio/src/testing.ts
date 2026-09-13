import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "@hull/blueprint";
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

// A studio server over a fresh temporary directory holding `text` as hull.yaml,
// with the directory so a test can look at the file afterwards.
export function studioDirectoryOver(text: string) {
  const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
  writeFileSync(join(directory, "hull.yaml"), text);
  return { app: createStudioServer({ directory }), directory };
}

export function studioOver(text: string) {
  return studioDirectoryOver(text).app;
}

export async function get<T>(text: string, path: string) {
  const response = await studioOver(text).request(path);
  return { status: response.status, body: (await response.json()) as T };
}

// The plan's sample as a developer might hand-format it: trailing comments
// with uneven spacing, a comment after a mapping key, a comment inside a
// sequence. Not in the Document API's canonical form.
export const handFormattedBlueprint = `# $schema: https://hull.dev/schema/v0/hull.json
# yaml-language-server: $schema=https://hull.dev/schema/v0/hull.json

name: todos
provider: aws
region: us-east-1   # closest region to the team

usage:                       # usage profile, low-end defaults from \`hull init\`
  requestsPerMonth: 100000
  storageGb: 1

intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway  # studio may change this
    entry: src/api/index.ts
    links:
      # the API owns the schema, so it gets read-write
      - to: db
        role: read-write   # only valid role in v0

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
        # bumped after the load test of 2026-08
        instanceClass: db.t4g.small
`;

// PUT /blueprint with a list of operations, over a fresh directory holding
// `text`; returns the answer and the file afterwards.
export async function patch<T>(text: string, ops: Op[]) {
  const { app, directory } = studioDirectoryOver(text);
  const response = await app.request("/blueprint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ops),
  });
  return { status: response.status, body: (await response.json()) as T, file: readFileSync(join(directory, "hull.yaml"), "utf8") };
}

// The lines removed from `before` and added in `after`, by longest common
// subsequence, so a test states exactly which lines an edit touched.
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed, added };
}

// Every comment in the text, in order, for asserting none was lost.
export function comments(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes("#"))
    .map((line) => line.slice(line.indexOf("#")));
}
