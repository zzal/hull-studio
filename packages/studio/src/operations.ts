// Plan, deploy and destroy as the studio runs them: through an operator
// handed in by whoever starts the studio, so this package never knows
// Pulumi. The CLI builds the operator from the functions its own commands
// use; the tests use a fake. One operation at a time; edits are refused
// while one runs.

// Hull's view of an operation in progress, independent of the engine: one
// event per resource operation phase, the engine's diagnostics, a final
// summary, and the notes the CLI prints as plain lines.
export type ProgressEvent =
  | { phase: "started" | "done" | "failed"; operation: string; type: string; name: string }
  // What the provider has to say about a failure or a concern, in its
  // words, attributed to a resource when the engine knows which.
  | { phase: "diagnostic"; severity: "warning" | "error"; name?: string; message: string }
  | { phase: "summary"; changes: Record<string, number>; durationSeconds: number }
  // A line for the developer: which account, which bucket, what was written.
  | { phase: "note"; message: string };

export type OnProgress = (event: ProgressEvent) => void;

export const operationKinds = ["plan", "deploy", "destroy"] as const;
export type OperationKind = (typeof operationKinds)[number];

// The environment's expected monthly figure beside a plan, from the
// estimate the studio serves.
export type PlanEstimate = { expected: number; low: number; high: number; withFreeTier: number; label: string };
export type PlanOutcome = { changes: Record<string, number>; estimate: PlanEstimate };
export type DeployOutcome = { apiUrl?: string };

export type Operator = {
  plan(environment: string, onProgress: OnProgress): Promise<PlanOutcome>;
  deploy(environment: string, onProgress: OnProgress): Promise<DeployOutcome>;
  destroy(environment: string, onProgress: OnProgress): Promise<void>;
};

export type OperationStatus = "running" | "succeeded" | "failed";

export type Operation = {
  id: number;
  kind: OperationKind;
  environment: string;
  status: OperationStatus;
  startedAt: string;
  events: ProgressEvent[];
  outcome?: PlanOutcome | DeployOutcome | null;
  // The failure in the words the CLI would print.
  error?: string;
};

// What the WebSocket carries about an operation: its start, each progress
// event, and its end with the outcome or the error.
export type OperationMessage =
  | { event: "operation"; operation: Operation; progress?: ProgressEvent }
  | { event: "changed" };

export type Operations = ReturnType<typeof createOperations>;

export function createOperations(operator?: Operator) {
  let current: Operation | undefined;
  let nextId = 1;
  const listeners = new Set<(message: OperationMessage) => void>();
  const notify = (message: OperationMessage) => {
    for (const listener of listeners) listener(message);
  };
  // What the WebSocket gets: the operation without its event log, which
  // the dashboard accumulates from the progress messages.
  const snapshot = (operation: Operation): Operation => ({ ...operation, events: [] });

  return {
    available: operator !== undefined,
    running: () => current?.status === "running",
    current: () => current,
    subscribe(listener: (message: OperationMessage) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Starts the operation, or returns undefined when one is running. The
    // operation runs in the background; its end reaches the listeners.
    start(kind: OperationKind, environment: string): Operation | undefined {
      if (!operator) throw new Error("no operator");
      if (current?.status === "running") return undefined;
      const operation: Operation = { id: nextId++, kind, environment, status: "running", startedAt: new Date().toISOString(), events: [] };
      current = operation;
      notify({ event: "operation", operation: snapshot(operation) });
      const onProgress = (event: ProgressEvent) => {
        operation.events.push(event);
        notify({ event: "operation", operation: snapshot(operation), progress: event });
      };
      const run = kind === "plan" ? operator.plan(environment, onProgress) : kind === "deploy" ? operator.deploy(environment, onProgress) : operator.destroy(environment, onProgress);
      void run.then(
        (outcome) => {
          operation.status = "succeeded";
          operation.outcome = outcome ?? null;
          notify({ event: "operation", operation: snapshot(operation) });
        },
        (error: unknown) => {
          operation.status = "failed";
          operation.error = error instanceof Error ? error.message : String(error);
          notify({ event: "operation", operation: snapshot(operation) });
        },
      );
      return operation;
    },
  };
}

export const isOperationKind = (kind: unknown): kind is OperationKind => typeof kind === "string" && (operationKinds as readonly string[]).includes(kind);
