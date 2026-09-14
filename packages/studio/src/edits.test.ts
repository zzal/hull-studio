import { loadBlueprint, type Blueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { describe, expect, it } from "vitest";
import { refusalAt, resolutionEdit, usageEdit } from "./edits.js";
import { sampleBlueprint } from "./testing.js";

// The dashboard's edits, as operations for PUT /blueprint. The estimate shows
// the usage profile merged for one environment, so an edit changes the line
// that value came from: the environment's own line when it has one, the
// blueprint's line otherwise. Nothing else is editable in v0.

const blueprint = loadBlueprint(sampleBlueprint, vocabulary).blueprint as Blueprint;

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
});

describe("resolutionEdit", () => {
  it("targets the intent's resolution line", () => {
    expect(resolutionEdit("api", "fargate-load-balancer")).toEqual({
      op: "set",
      path: ["intents", "api", "resolution"],
      value: "fargate-load-balancer",
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
