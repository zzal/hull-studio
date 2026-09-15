import type { ProgressEvent } from "@hull/studio";

// Hull's view of a deploy in progress, independent of the engine. The type
// and the line rendering live in the studio package so the dashboard shows
// the same lines the CLI prints; this module keeps what a failure report
// needs.
export type { ProgressEvent };
export { renderChanges, renderProgress } from "@hull/studio";

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
