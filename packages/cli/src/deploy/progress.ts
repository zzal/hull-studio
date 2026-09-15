import type { ProgressEvent } from "@hull/studio";

// Hull's view of a deploy in progress, independent of the engine (the type
// lives in the studio package so the dashboard renders the same events):
// the CLI renders them as lines.
export type { ProgressEvent };

// Pulumi's operation names in the developer's words; unknown ones pass through.
const changeWords: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  same: "unchanged",
  replace: "replaced",
};

// The same, for what a plan would do.
const plannedWords: Record<string, string> = {
  create: "to create",
  update: "to update",
  delete: "to delete",
  same: "unchanged",
  replace: "to replace",
};

export function renderProgress(event: ProgressEvent): string {
  if (event.phase === "note") return event.message;
  if (event.phase === "summary") {
    const changes = Object.entries(event.changes)
      .filter(([, count]) => count > 0)
      .map(([operation, count]) => `${count} ${changeWords[operation] ?? operation}`);
    return `Summary: ${changes.length > 0 ? changes.join(", ") : "no changes"} in ${duration(event.durationSeconds)}.`;
  }
  if (event.phase === "diagnostic") return `  ${event.severity}: ${event.message.trim()}`;
  if (event.phase === "planned") return `  ${event.operation.padEnd(7)}  ${event.type}  ${event.name}`;
  return `  ${event.phase.padEnd(7)}  ${event.operation.padEnd(6)}  ${event.type}  ${event.name}`;
}

// The change counts of a preview as one line.
export function renderChanges(changes: Record<string, number>): string {
  const lines = Object.entries(changes)
    .filter(([, count]) => count > 0)
    .map(([operation, count]) => `${count} ${plannedWords[operation] ?? operation}`);
  return `Changes: ${lines.length > 0 ? lines.join(", ") : "none"}.`;
}

function duration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes > 0 ? `${minutes}m ${whole % 60}s` : `${whole}s`;
}

// One resource the operation failed on, with what the provider said about it.
export type FailedResource = { type: string; name: string; reasons: string[] };

// Watches the progress and keeps what a failure report needs: the failed
// resources and the error diagnostics the engine attributed to them. The
// engine's own unattributed lines ("update failed") are not reasons.
export function watchFailures(onProgress: (event: ProgressEvent) => void) {
  const failed: { type: string; name: string }[] = [];
  const errors: { name: string; message: string }[] = [];
  return {
    onProgress(event: ProgressEvent) {
      if (event.phase === "failed") failed.push({ type: event.type, name: event.name });
      if (event.phase === "diagnostic" && event.severity === "error" && event.name !== undefined) {
        errors.push({ name: event.name, message: event.message.trim() });
      }
      onProgress(event);
    },
    failures(): FailedResource[] {
      return failed.map(({ type, name }) => ({
        type,
        name,
        reasons: errors.filter((error) => error.name === name).map((error) => error.message),
      }));
    },
    // The failure in the developer's words: the resources and their
    // reasons when resources failed, the engine's words otherwise, then
    // what to do.
    report(operation: string, error: unknown, advice: string): Error {
      const engineMessage = error instanceof Error ? error.message : String(error);
      const failures = this.failures();
      if (failures.length === 0) return new Error(`${operation} failed: ${engineMessage}\n${advice}`);
      const lines = failures.map(({ type, name, reasons }) => `  ${type} ${name}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`);
      return new Error(`${operation} failed:\n${lines.join("\n")}\n${advice}`);
    },
  };
}
