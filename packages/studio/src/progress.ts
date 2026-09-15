import type { ProgressEvent } from "./operations.js";

// Progress events as lines, for the CLI and the dashboard alike, so a
// failure or a summary reads the same on both surfaces.

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
