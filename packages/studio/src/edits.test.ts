import { loadBlueprint, type Blueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { describe, expect, it } from "vitest";
import {
  addIntentEdit,
  addLinkEdit,
  entryEdit,
  environmentUsageEdit,
  headerEdit,
  overrideEdit,
  refusalAt,
  removeIntentEdit,
  removeLinkEdit,
  renameIntentEdit,
  resetEnvironmentUsageEdit,
  resetOverrideEdit,
  resolutionEdit,
  usageEdit,
} from "./edits.js";
import { demoBlueprint, sampleBlueprint } from "./testing.js";

// The dashboard's edits, as operations for PUT /blueprint. Each builder
// turns one act in the inspector, the palette or the header into the
// operations that make it one patch, so the file never passes through an
// invalid state.

const blueprint = loadBlueprint(sampleBlueprint, vocabulary).blueprint as Blueprint;
const demo = loadBlueprint(demoBlueprint, vocabulary).blueprint as Blueprint;

describe("usageEdit", () => {
  it("targets the blueprint's usage line when the environment does not set the field", () => {
    expect(usageEdit(blueprint, "dev", "requestsPerMonth", 250000)).toEqual({
      op: "set",
      path: ["usage", "requestsPerMonth"],
      value: 250000,
    });
  });

  it("targets the environment's own usage line when it sets the field", () => {
    expect(usageEdit(blueprint, "prod", "requestsPerMonth", 3000000)).toEqual({
      op: "set",
      path: ["environments", "prod", "usage", "requestsPerMonth"],
      value: 3000000,
    });
  });

  it("targets the blueprint's line for a field the environment leaves alone", () => {
    expect(usageEdit(blueprint, "prod", "storageGb", 5)).toEqual({ op: "set", path: ["usage", "storageGb"], value: 5 });
  });

  it("pins a value for one environment on request, and resets it by deleting the line", () => {
    expect(environmentUsageEdit("prod", "messagesPerMonth", 2000000)).toEqual({
      op: "set",
      path: ["environments", "prod", "usage", "messagesPerMonth"],
      value: 2000000,
    });
    expect(resetEnvironmentUsageEdit("prod", "messagesPerMonth")).toEqual({ op: "delete", path: ["environments", "prod", "usage", "messagesPerMonth"] });
  });
});

describe("resolutionEdit, entryEdit and headerEdit", () => {
  it("target the intent's resolution line", () => {
    expect(resolutionEdit("api", "fargate-load-balancer")).toEqual({
      op: "set",
      path: ["intents", "api", "resolution"],
      value: "fargate-load-balancer",
    });
  });

  it("target the tier's entry line and the blueprint's header scalars", () => {
    expect(entryEdit("api", "src/api/main.ts")).toEqual({ op: "set", path: ["intents", "api", "entry"], value: "src/api/main.ts" });
    expect(headerEdit("region", "eu-west-1")).toEqual({ op: "set", path: ["region"], value: "eu-west-1" });
  });
});

describe("renameIntentEdit", () => {
  it("renames the key, retargets every link to it and its overrides in every environment", () => {
    expect(renameIntentEdit(demo, "db", "analytics")).toEqual([
      { op: "rename", path: ["intents", "db"], to: "analytics" },
      { op: "set", path: ["intents", "api", "links", 0, "to"], value: "analytics" },
      { op: "set", path: ["intents", "worker", "links", 1, "to"], value: "analytics" },
      { op: "rename", path: ["environments", "prod", "overrides", "db"], to: "analytics" },
    ]);
  });

  it("is only the rename for an intent nothing points at", () => {
    expect(renameIntentEdit(blueprint, "api", "web")).toEqual([{ op: "rename", path: ["intents", "api"], to: "web" }]);
  });
});

describe("addIntentEdit", () => {
  it("names a queue and a worker after their kind and gives a tier a placeholder entry", () => {
    expect(addIntentEdit(blueprint, "queue", "sqs-standard")).toEqual({
      name: "queue",
      op: { op: "set", path: ["intents", "queue"], value: { kind: "queue", resolution: "sqs-standard" } },
    });
    expect(addIntentEdit(blueprint, "background-worker", "lambda-worker")).toEqual({
      name: "worker",
      op: { op: "set", path: ["intents", "worker"], value: { kind: "background-worker", resolution: "lambda-worker", entry: "src/worker/index.ts" } },
    });
  });

  it("takes the first free name when the kind's name is used", () => {
    expect(addIntentEdit(blueprint, "http-api", "lambda-api-gateway").name).toBe("api2");
    expect(addIntentEdit(blueprint, "relational-database", "rds-postgres").name).toBe("db2");
    expect(addIntentEdit(demo, "queue", "sqs-standard").name).toBe("queue");
  });
});

describe("addLinkEdit and removeLinkEdit", () => {
  it("appends the link after the tier's existing ones", () => {
    expect(addLinkEdit(demo, "api", "jobs", "produce")).toEqual({
      op: "set",
      path: ["intents", "api", "links", 2],
      value: { to: "jobs", role: "produce" },
    });
    expect(addLinkEdit(blueprint, "api", "db", "read-write").path).toEqual(["intents", "api", "links", 1]);
  });

  it("starts the links of a tier that has none", () => {
    const unlinked = { ...blueprint, intents: { ...blueprint.intents, admin: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/admin.ts" } } } as Blueprint;

    expect(addLinkEdit(unlinked, "admin", "db", "read-write").path).toEqual(["intents", "admin", "links", 0]);
  });

  it("deletes the link by index", () => {
    expect(removeLinkEdit("worker", 1)).toEqual({ op: "delete", path: ["intents", "worker", "links", 1] });
  });
});

describe("removeIntentEdit", () => {
  it("deletes the intent and its overrides in every environment, never the links to it", () => {
    expect(removeIntentEdit(demo, "worker")).toEqual([
      { op: "delete", path: ["intents", "worker"] },
      { op: "delete", path: ["environments", "prod", "overrides", "worker"] },
    ]);
    expect(removeIntentEdit(demo, "jobs")).toEqual([{ op: "delete", path: ["intents", "jobs"] }]);
  });
});

describe("overrideEdit and resetOverrideEdit", () => {
  it("target the environment's override of the parameter", () => {
    expect(overrideEdit("prod", "db", "instanceClass", "db.t4g.medium")).toEqual({
      op: "set",
      path: ["environments", "prod", "overrides", "db", "instanceClass"],
      value: "db.t4g.medium",
    });
    expect(resetOverrideEdit("prod", "db", "instanceClass")).toEqual({
      op: "delete",
      path: ["environments", "prod", "overrides", "db", "instanceClass"],
    });
  });
});

describe("refusalAt", () => {
  const path = ["usage", "requestsPerMonth"];

  it("picks the diagnostics at the edited path", () => {
    expect(
      refusalAt(path, {
        error: "the patch makes hull.yaml invalid",
        diagnostics: [
          { path: ["usage", "requestsPerMonth"], message: "Too small: expected number to be >=0" },
          { path: ["usage", "storageGb"], message: "elsewhere" },
        ],
      }),
    ).toEqual(["Too small: expected number to be >=0"]);
  });

  it("shows every diagnostic with its path when none is at the edited path", () => {
    expect(refusalAt(path, { error: "invalid", diagnostics: [{ path: ["intents", "api", "entry"], message: "elsewhere" }] })).toEqual([
      "intents.api.entry: elsewhere",
    ]);
  });

  it("falls back to the error when there is no diagnostic", () => {
    expect(refusalAt(path, { error: "cannot reach usage.requestsPerMonth: usage holds a value, not a collection" })).toEqual([
      "cannot reach usage.requestsPerMonth: usage holds a value, not a collection",
    ]);
  });
});
