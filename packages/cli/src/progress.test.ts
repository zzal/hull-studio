import type { EngineEvent } from "@pulumi/pulumi/automation/index.js";
import { describe, expect, it } from "vitest";
import { progressFromEngineEvent } from "./deploy/pulumi-engine.js";
import { renderProgress } from "./deploy/progress.js";

// Seam 2, below the command: the one place Pulumi's event shapes are
// interpreted. Each engine event maps to a Hull progress event (resource
// type and name, operation, phase) or to nothing, and the CLI renders those
// as lines.

const urn = "urn:pulumi:dev::todos::aws:rds/instance:Instance::db";
const metadata = { op: "create", urn, type: "aws:rds/instance:Instance" };
const base = { sequence: 1, timestamp: 0 };

describe("progressFromEngineEvent", () => {
  it("maps a resource's pre, outputs and failure events to started, done and failed", () => {
    expect(progressFromEngineEvent({ ...base, resourcePreEvent: { metadata } } as EngineEvent)).toEqual({
      phase: "started",
      operation: "create",
      type: "aws:rds/instance:Instance",
      name: "db",
    });
    expect(progressFromEngineEvent({ ...base, resOutputsEvent: { metadata } } as EngineEvent)).toMatchObject({ phase: "done" });
    expect(progressFromEngineEvent({ ...base, resOpFailedEvent: { metadata, status: 1, steps: 1 } } as EngineEvent)).toMatchObject({
      phase: "failed",
    });
  });

  it("maps the summary event to the change counts and duration", () => {
    const summary = { maybeCorrupt: false, durationSeconds: 12, resourceChanges: { create: 3, same: 1 }, policyPacks: {} };

    expect(progressFromEngineEvent({ ...base, summaryEvent: summary } as EngineEvent)).toEqual({
      phase: "summary",
      changes: { create: 3, same: 1 },
      durationSeconds: 12,
    });
  });

  it("forwards warnings and errors, which say why a resource failed", () => {
    const diagnostic = (severity: string) => ({ ...base, diagnosticEvent: { message: "why\n", severity, color: "", streamID: 0, ephemeral: false } });

    expect(progressFromEngineEvent(diagnostic("error") as unknown as EngineEvent)).toEqual({ phase: "diagnostic", severity: "error", message: "why\n" });
    expect(progressFromEngineEvent(diagnostic("warning") as unknown as EngineEvent)).toMatchObject({ severity: "warning" });
    expect(progressFromEngineEvent(diagnostic("info") as unknown as EngineEvent)).toBeUndefined();
    expect(renderProgress({ phase: "diagnostic", severity: "error", message: "why\n" })).toBe("  error: why");
  });

  it("drops the stack and provider resources, which the developer never declared", () => {
    const stack = { op: "create", urn: "urn:pulumi:dev::todos::pulumi:pulumi:Stack::todos-dev", type: "pulumi:pulumi:Stack" };
    const provider = { op: "create", urn: "urn:pulumi:dev::todos::pulumi:providers:aws::default", type: "pulumi:providers:aws" };

    expect(progressFromEngineEvent({ ...base, resourcePreEvent: { metadata: stack } } as EngineEvent)).toBeUndefined();
    expect(progressFromEngineEvent({ ...base, resOutputsEvent: { metadata: provider } } as EngineEvent)).toBeUndefined();
    const debug = { ...base, diagnosticEvent: { message: "x", severity: "debug", color: "", streamID: 0, ephemeral: false } };
    expect(progressFromEngineEvent(debug as unknown as EngineEvent)).toBeUndefined();
  });
});

describe("renderProgress", () => {
  it("renders the summary in the developer's words", () => {
    expect(renderProgress({ phase: "summary", changes: { create: 2, update: 1, delete: 3, same: 4, replace: 1 }, durationSeconds: 61 })).toBe(
      "Summary: 2 created, 1 updated, 3 deleted, 4 unchanged, 1 replaced in 1m 1s.",
    );
    expect(renderProgress({ phase: "summary", changes: {}, durationSeconds: 3 })).toBe("Summary: no changes in 3s.");
  });
});
