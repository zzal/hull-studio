// Hull's view of a deploy in progress, independent of the engine: one event
// per resource operation phase and a final summary. The CLI renders them as
// lines; the studio may later render them as a view.
export type ProgressEvent =
  | { phase: "started" | "done" | "failed"; operation: string; type: string; name: string }
  // What the engine has to say about a failure or a concern, in its words.
  | { phase: "diagnostic"; severity: "warning" | "error"; message: string }
  | { phase: "summary"; changes: Record<string, number>; durationSeconds: number };

// Pulumi's operation names in the developer's words; unknown ones pass through.
const changeWords: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  same: "unchanged",
  replace: "replaced",
};

export function renderProgress(event: ProgressEvent): string {
  if (event.phase === "summary") {
    const changes = Object.entries(event.changes)
      .filter(([, count]) => count > 0)
      .map(([operation, count]) => `${count} ${changeWords[operation] ?? operation}`);
    return `Summary: ${changes.length > 0 ? changes.join(", ") : "no changes"} in ${duration(event.durationSeconds)}.`;
  }
  if (event.phase === "diagnostic") return `  ${event.severity}: ${event.message.trim()}`;
  return `  ${event.phase.padEnd(7)}  ${event.operation.padEnd(6)}  ${event.type}  ${event.name}`;
}

function duration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes > 0 ? `${minutes}m ${whole % 60}s` : `${whole}s`;
}
