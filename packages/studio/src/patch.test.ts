import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadResult, Op } from "@hull/blueprint";
import { describe, expect, it, vi } from "vitest";
import { createStudioServer, type ErrorResponse } from "./index.js";
import { blueprintDirectory, comments, handFormattedBlueprint, lineDiff, patch, sampleBlueprint, studioDirectoryOver } from "./testing.js";

// PUT /blueprint with a list of operations: the server applies them to the
// blueprint text, validates the result, and either writes the file and
// answers with the new model, or rejects with diagnostics and leaves the file
// untouched. Edits touch only the lines they change and keep every comment.

const apply = (text: string, ops: Op[]) => patch<LoadResult>(text, ops);

describe("PUT /blueprint on a hand-formatted blueprint", () => {
  // The two edits of the milestone's spike, on the plan's sample: existing
  // plain scalars, spliced by byte range, so the file's own formatting and
  // every comment survive untouched.
  it("changes the usage profile and the API resolution in exactly four lines", async () => {
    const { status, body, file } = await apply(handFormattedBlueprint, [
      { op: "set", path: ["usage", "requestsPerMonth"], value: 250000 },
      { op: "set", path: ["intents", "api", "resolution"], value: "fargate-load-balancer" },
    ]);

    expect(status).toBe(200);
    expect(body.diagnostics).toEqual([]);
    expect(body.blueprint?.usage.requestsPerMonth).toBe(250000);
    expect(body.blueprint?.intents.api?.resolution).toBe("fargate-load-balancer");
    expect(lineDiff(handFormattedBlueprint, file)).toEqual({
      removed: ["  requestsPerMonth: 100000", "    resolution: lambda-api-gateway  # studio may change this"],
      added: ["  requestsPerMonth: 250000", "    resolution: fargate-load-balancer  # studio may change this"],
    });
    expect(comments(file)).toEqual(comments(handFormattedBlueprint));
  });
});

describe("PUT /blueprint on a canonical blueprint", () => {
  // Structural edits go through the Document API; on a file in its canonical
  // form (what `hull init` writes) they touch only the affected lines.
  it("adds a key on one line", async () => {
    const { status, file } = await apply(sampleBlueprint, [
      { op: "set", path: ["environments", "prod", "overrides", "db", "multiAz"], value: true },
    ]);

    expect(status).toBe(200);
    expect(lineDiff(sampleBlueprint, file)).toEqual({ removed: [], added: ["        multiAz: true"] });
  });

  it("deletes a key on one line", async () => {
    const twoOverrides = sampleBlueprint.replace(
      "        instanceClass: db.t4g.small\n",
      "        instanceClass: db.t4g.small\n        multiAz: true\n",
    );

    const { status, file } = await apply(twoOverrides, [
      { op: "delete", path: ["environments", "prod", "overrides", "db", "multiAz"] },
    ]);

    expect(status).toBe(200);
    expect(lineDiff(twoOverrides, file)).toEqual({ removed: ["        multiAz: true"], added: [] });
  });

  it("appends a link on its own lines", async () => {
    const twoDatabases = sampleBlueprint.replace(
      "environments:\n",
      "  analytics:\n    kind: relational-database\n    resolution: rds-postgres\n\nenvironments:\n",
    );

    const { status, body, file } = await apply(twoDatabases, [
      { op: "set", path: ["intents", "api", "links", 1], value: { to: "analytics", role: "read-write" } },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.intents.api).toMatchObject({
      links: [
        { to: "db", role: "read-write" },
        { to: "analytics", role: "read-write" },
      ],
    });
    expect(lineDiff(twoDatabases, file)).toEqual({
      removed: [],
      added: ["      - to: analytics", "        role: read-write"],
    });
  });

  // `dev: {}` is an empty flow mapping; what the set creates inside it must
  // come out in block style, not `dev: { overrides: { db: { ... } } }`.
  it("fills an empty environment in block style", async () => {
    const { status, file } = await apply(sampleBlueprint, [
      { op: "set", path: ["environments", "dev", "overrides", "db", "instanceClass"], value: "db.t4g.micro" },
    ]);

    expect(status).toBe(200);
    expect(lineDiff(sampleBlueprint, file)).toEqual({
      removed: ["  dev: {}"],
      added: ["  dev:", "    overrides:", "      db:", "        instanceClass: db.t4g.micro"],
    });
  });

  it("quotes a value the plain scalar could not carry", async () => {
    const { status, body, file } = await apply(sampleBlueprint, [{ op: "set", path: ["region"], value: "true" }]);

    expect(status).toBe(200);
    expect(body.blueprint?.region).toBe("true");
    expect(lineDiff(sampleBlueprint, file)).toEqual({ removed: ["region: us-east-1"], added: ['region: "true"'] });
  });

  // Not a scalar edit even though the target is one: the Document API
  // renders the mapping on its own lines.
  it("replaces a scalar by a mapping in block style", async () => {
    const { status, body, file } = await apply(sampleBlueprint, [
      { op: "set", path: ["environments", "prod", "usage"], value: { requestsPerMonth: 3000000, storageGb: 5 } },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.environments.prod?.usage).toEqual({ requestsPerMonth: 3000000, storageGb: 5 });
    expect(lineDiff(sampleBlueprint, file)).toEqual({
      removed: ["      requestsPerMonth: 2000000"],
      added: ["      requestsPerMonth: 3000000", "      storageGb: 5"],
    });
  });

  it("fills a key left without a value", async () => {
    const emptyEntry = sampleBlueprint.replace("    entry: src/api/index.ts\n", "    entry:\n");

    const { status, body, file } = await apply(emptyEntry, [
      { op: "set", path: ["intents", "api", "entry"], value: "src/api/index.ts" },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.intents.api).toMatchObject({ entry: "src/api/index.ts" });
    expect(lineDiff(emptyEntry, file)).toEqual({ removed: ["    entry:"], added: ["    entry: src/api/index.ts"] });
  });

  it("quotes a value set inside a flow mapping", async () => {
    const flowUsage = sampleBlueprint.replace("    usage:\n      requestsPerMonth: 2000000\n", "    usage: { requestsPerMonth: 2000000 }\n");

    const { status, body, file } = await apply(flowUsage, [
      { op: "set", path: ["environments", "prod", "usage", "requestsPerMonth"], value: "1, 2" },
    ]);

    expect(status).toBe(422);
    expect((body as unknown as ErrorResponse).diagnostics).toEqual([
      { path: ["environments", "prod", "usage", "requestsPerMonth"], message: "Invalid input: expected number, received string" },
    ]);
    expect(file).toBe(flowUsage);
  });

  it("leaves the file byte-identical for an empty list of operations", async () => {
    const { status, file } = await apply(sampleBlueprint, []);

    expect(status).toBe(200);
    expect(file).toBe(sampleBlueprint);
  });
});

describe("PUT /blueprint renaming an intent", () => {
  // The inspector's rename: the intent's key, every link's `to` that points
  // at it, and its overrides in every environment, in one patch. The key
  // keeps its place and its comments; the links are scalar splices.
  const rename: Op[] = [
    { op: "rename", path: ["intents", "db"], to: "analytics" },
    { op: "set", path: ["intents", "api", "links", 0, "to"], value: "analytics" },
    { op: "rename", path: ["environments", "prod", "overrides", "db"], to: "analytics" },
  ];

  it("rewrites the key, the link and the override in place, comments intact", async () => {
    const { status, body, file } = await apply(handFormattedBlueprint, rename);

    expect(status).toBe(200);
    expect(Object.keys(body.blueprint?.intents ?? {})).toEqual(["api", "analytics"]);
    expect(body.blueprint?.intents.api).toMatchObject({ links: [{ to: "analytics", role: "read-write" }] });
    expect(body.blueprint?.environments.prod?.overrides).toEqual({ analytics: { instanceClass: "db.t4g.small" } });
    expect(comments(file)).toEqual(comments(handFormattedBlueprint));
    expect(lineDiff(handFormattedBlueprint, file).removed).toEqual([
      "region: us-east-1   # closest region to the team",
      "usage:                       # usage profile, low-end defaults from `hull init`",
      "    resolution: lambda-api-gateway  # studio may change this",
      "      - to: db",
      "        role: read-write   # only valid role in v0",
      "  db:",
      "      db:",
    ]);
  });

  it("is refused untouched when the new name collides with an intent", async () => {
    const { status, body, file } = await patch<ErrorResponse>(sampleBlueprint, [{ op: "rename", path: ["intents", "db"], to: "api" }]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot rename intents.db to api: intents.api already exists" });
    expect(file).toBe(sampleBlueprint);
  });

  it("is refused untouched when the new name is not a valid intent name", async () => {
    const { status, body, file } = await patch<ErrorResponse>(sampleBlueprint, [
      { op: "rename", path: ["intents", "db"], to: "Main-DB" },
      { op: "set", path: ["intents", "api", "links", 0, "to"], value: "Main-DB" },
    ]);

    expect(status).toBe(422);
    expect(body.diagnostics).toEqual([
      { path: ["intents", "api", "links", 0, "to"], message: "intent names must be lower-case letters, digits or underscores, starting with a letter" },
      { path: ["intents", "Main-DB"], message: "intent names must be lower-case letters, digits or underscores, starting with a letter" },
    ]);
    expect(file).toBe(sampleBlueprint);
  });

  it("is refused for a key that does not exist", async () => {
    const { status, body } = await patch<ErrorResponse>(sampleBlueprint, [{ op: "rename", path: ["intents", "cache"], to: "db2" }]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot rename intents.cache: nothing there" });
  });
});

describe("PUT /blueprint with the inspector's edits", () => {
  it("removes the only link and leaves no empty links sequence", async () => {
    const { status, body, file } = await apply(sampleBlueprint, [{ op: "delete", path: ["intents", "api", "links", 0] }]);

    expect(status).toBe(200);
    expect(body.blueprint?.intents.api).toEqual({ kind: "http-api", resolution: "lambda-api-gateway", entry: "src/api/index.ts" });
    expect(lineDiff(sampleBlueprint, file)).toEqual({ removed: ["    links:", "      - to: db", "        role: read-write"], added: [] });
  });

  it("changes the name and the region as byte-exact scalar splices", async () => {
    const { status, file } = await apply(handFormattedBlueprint, [
      { op: "set", path: ["name"], value: "notes" },
      { op: "set", path: ["region"], value: "eu-west-1" },
    ]);

    expect(status).toBe(200);
    expect(lineDiff(handFormattedBlueprint, file)).toEqual({
      removed: ["name: todos", "region: us-east-1   # closest region to the team"],
      added: ["name: notes", "region: eu-west-1   # closest region to the team"],
    });
  });

  // The palette's add: a new intent lands at the end of the section with the
  // blank line the canonical form puts between intents.
  it("adds an intent on its own lines after a blank line", async () => {
    const { status, file } = await apply(sampleBlueprint, [
      { op: "set", path: ["intents", "jobs"], value: { kind: "queue", resolution: "sqs-standard" } },
    ]);

    expect(status).toBe(200);
    expect(file).toContain("    resolution: rds-postgres\n\n  jobs:\n    kind: queue\n    resolution: sqs-standard\n\nenvironments:");
  });

  it("adds the first intent of a blank blueprint in block style without a blank line", async () => {
    const blank = sampleBlueprint.replace(/intents:[\s\S]*?\nenvironments:/, "intents: {}\n\nenvironments:");

    const { status, file } = await apply(blank, [{ op: "set", path: ["intents", "db"], value: { kind: "relational-database", resolution: "rds-postgres" } }]);

    expect(status).toBe(200);
    expect(file).toContain("intents:\n  db:\n    kind: relational-database\n    resolution: rds-postgres\n\nenvironments:");
  });
});

describe("PUT /blueprint deleting the last override", () => {
  it("removes the emptied parent mappings and keeps the environment's other keys", async () => {
    const { status, body, file } = await apply(sampleBlueprint, [
      { op: "delete", path: ["environments", "prod", "overrides", "db", "instanceClass"] },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.environments.prod).toEqual({ usage: { requestsPerMonth: 2000000 } });
    expect(lineDiff(sampleBlueprint, file)).toEqual({
      removed: ["    overrides:", "      db:", "        instanceClass: db.t4g.small"],
      added: [],
    });
  });

  // An environment is a declared thing, like `dev: {}`; emptying it must not
  // delete it.
  it("keeps an environment left with nothing in it", async () => {
    const overridesOnly = sampleBlueprint.replace("    usage:\n      requestsPerMonth: 2000000\n", "");

    const { status, body, file } = await apply(overridesOnly, [
      { op: "delete", path: ["environments", "prod", "overrides", "db", "instanceClass"] },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.environments).toEqual({ dev: {}, prod: {} });
    expect(lineDiff(overridesOnly, file)).toEqual({
      removed: ["  prod:", "    overrides:", "      db:", "        instanceClass: db.t4g.small"],
      added: ["  prod: {}"],
    });
  });
});

describe("PUT /blueprint on a hand-formatted blueprint, structural edit", () => {
  // The Document API normalizes the file once: one space before a trailing
  // comment, a comment after a mapping key moved under it. Every comment
  // stays, and a second structural edit touches only its own lines.
  it("normalizes the file once, keeps every comment, and is idempotent after that", async () => {
    const first = await apply(handFormattedBlueprint, [
      { op: "set", path: ["environments", "prod", "overrides", "db", "multiAz"], value: true },
    ]);

    expect(first.status).toBe(200);
    expect(comments(first.file)).toEqual(comments(handFormattedBlueprint));
    expect(lineDiff(handFormattedBlueprint, first.file)).toEqual({
      removed: [
        "region: us-east-1   # closest region to the team",
        "usage:                       # usage profile, low-end defaults from `hull init`",
        "    resolution: lambda-api-gateway  # studio may change this",
        "        role: read-write   # only valid role in v0",
      ],
      added: [
        "region: us-east-1 # closest region to the team",
        "usage:",
        "  # usage profile, low-end defaults from `hull init`",
        "    resolution: lambda-api-gateway # studio may change this",
        "        role: read-write # only valid role in v0",
        "        multiAz: true",
      ],
    });

    const second = await apply(first.file, [{ op: "delete", path: ["environments", "prod", "overrides", "db", "multiAz"] }]);

    expect(second.status).toBe(200);
    expect(lineDiff(first.file, second.file)).toEqual({ removed: ["        multiAz: true"], added: [] });
  });
});

describe("PUT /blueprint rejections", () => {
  const rejected = (text: string, ops: Op[]) => patch<ErrorResponse>(text, ops);

  it("rejects a patch that makes the blueprint invalid and leaves the file byte-identical", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [
      { op: "set", path: ["intents", "api", "resolution"], value: "rds-postgres" },
    ]);

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "the patch makes hull.yaml invalid",
      diagnostics: [
        {
          path: ["intents", "api", "resolution"],
          message:
            '"rds-postgres" is not a candidate resolution of kind http-api on provider aws; candidate resolutions are lambda-api-gateway, fargate-load-balancer',
        },
      ],
    });
    expect(file).toBe(sampleBlueprint);
  });

  it("rejects a set through a value", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [{ op: "set", path: ["name", "first"], value: "x" }]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot reach name.first: name holds a value, not a collection" });
    expect(file).toBe(sampleBlueprint);
  });

  it("rejects a delete through a value", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [{ op: "delete", path: ["region", "zone"] }]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot reach region.zone: region holds a value, not a collection" });
    expect(file).toBe(sampleBlueprint);
  });

  it("rejects a delete of nothing", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [{ op: "delete", path: ["usage", "activeUsers"] }]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot delete usage.activeUsers: nothing there" });
    expect(file).toBe(sampleBlueprint);
  });

  it("rejects a sequence index past the end", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [
      { op: "set", path: ["intents", "api", "links", 3, "role"], value: "read-write" },
    ]);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "cannot reach intents.api.links.3.role: index 3 is past the end of a sequence of 1" });
    expect(file).toBe(sampleBlueprint);
  });

  it("rejects a sequence that would start past 0", async () => {
    const { status, body, file } = await rejected(sampleBlueprint, [
      { op: "set", path: ["intents", "db", "links", 2], value: { to: "db", role: "read-write" } },
    ]);

    expect(status).toBe(400);
    expect(body).toEqual({
      error: "cannot reach intents.db.links.2: intents.db.links does not exist, so index 2 has nothing before it",
    });
    expect(file).toBe(sampleBlueprint);
  });

  it("refuses to patch a blueprint that does not parse", async () => {
    const broken = "name: todos\nintents: [\n";

    const { status, body, file } = await rejected(broken, [{ op: "set", path: ["name"], value: "x" }]);

    expect(status).toBe(400);
    expect(body.error).toMatch(/^cannot patch a blueprint that does not parse: /);
    expect(file).toBe(broken);
  });

  it("rejects a body that is not a list of operations", async () => {
    const { app, directory } = studioDirectoryOver(sampleBlueprint);

    const response = await app.request("/blueprint", { method: "PUT", body: '{"op": "set"}' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body must be a list of set, delete and rename operations" });
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toBe(sampleBlueprint);
  });

  it("answers 404 when the directory has no blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));

    const response = await createStudioServer({ directory }).request("/blueprint", { method: "PUT", body: "[]" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `no hull.yaml in ${directory}` });
  });
});

describe("PUT /blueprint with the dashboard's edits", () => {
  // The two editable fields of v0 (issue #8), as the dashboard sends them.
  it("changes an environment's own usage line and nothing else", async () => {
    const { status, body, file } = await apply(handFormattedBlueprint, [
      { op: "set", path: ["environments", "prod", "usage", "requestsPerMonth"], value: 3000000 },
    ]);

    expect(status).toBe(200);
    expect(body.blueprint?.environments.prod?.usage).toEqual({ requestsPerMonth: 3000000 });
    expect(lineDiff(handFormattedBlueprint, file)).toEqual({
      removed: ["      requestsPerMonth: 2000000"],
      added: ["      requestsPerMonth: 3000000"],
    });
    expect(comments(file)).toEqual(comments(handFormattedBlueprint));
  });

  it("changes the storage line and nothing else", async () => {
    const { status, file } = await apply(handFormattedBlueprint, [{ op: "set", path: ["usage", "storageGb"], value: 2.5 }]);

    expect(status).toBe(200);
    expect(lineDiff(handFormattedBlueprint, file)).toEqual({ removed: ["  storageGb: 1"], added: ["  storageGb: 2.5"] });
    expect(comments(file)).toEqual(comments(handFormattedBlueprint));
  });

  it("rejects a negative usage number with a diagnostic at the field and leaves the file byte-identical", async () => {
    const { status, body, file } = await patch<ErrorResponse>(handFormattedBlueprint, [
      { op: "set", path: ["usage", "requestsPerMonth"], value: -1 },
    ]);

    expect(status).toBe(422);
    expect(body.diagnostics).toEqual([{ path: ["usage", "requestsPerMonth"], message: "Too small: expected number to be >=0" }]);
    expect(file).toBe(handFormattedBlueprint);
  });
});

describe("PUT /blueprint and onWrite", () => {
  // Every studio save regenerates the bindings (spec, "Compile, deploy,
  // bindings"); the studio hands the written model to whoever does that.
  it("calls onWrite with the new model after writing the file", async () => {
    const directory = blueprintDirectory(sampleBlueprint);
    const onWrite = vi.fn();
    const app = createStudioServer({ directory, onWrite });

    const response = await app.request("/blueprint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ op: "set", path: ["usage", "storageGb"], value: 2 }]),
    });

    expect(response.status).toBe(200);
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite.mock.calls[0]?.[0]).toMatchObject({ name: "todos", usage: { requestsPerMonth: 100000, storageGb: 2 } });
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toContain("  storageGb: 2\n");
  });

  it("does not call onWrite for a rejected patch", async () => {
    const onWrite = vi.fn();
    const app = createStudioServer({ directory: blueprintDirectory(sampleBlueprint), onWrite });

    const response = await app.request("/blueprint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ op: "set", path: ["usage", "requestsPerMonth"], value: -1 }]),
    });

    expect(response.status).toBe(422);
    expect(onWrite).not.toHaveBeenCalled();
  });
});
