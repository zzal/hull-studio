import { useState } from "react";
import { money } from "../../src/format.js";
import type { DeployOutcome, PlanOutcome } from "../../src/index.js";
import { renderChanges, renderProgress } from "../../src/progress.js";
import type { Operation, OperationKind } from "./api.js";

type Props = {
  environment: string;
  operation?: Operation;
  onStart: (kind: OperationKind) => Promise<string | undefined>;
};

// Plan, deploy and destroy for the selected environment, with the progress
// streamed as rows. A deploy runs the plan first and shows it with the
// figure before asking; a destroy asks, naming the environment. A failure
// shows the same message the CLI prints.
export function OperationsPanel({ environment, operation, onStart }: Props) {
  const [failure, setFailure] = useState<string>();
  // The environment whose plan awaits confirmation before its deploy.
  const [pendingDeploy, setPendingDeploy] = useState<string>();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const running = operation?.status === "running";

  const start = async (kind: OperationKind) => {
    setFailure(undefined);
    setFailure(await onStart(kind));
  };

  const planThenDeploy = async () => {
    setFailure(undefined);
    const refused = await onStart("plan");
    if (refused) setFailure(refused);
    else setPendingDeploy(environment);
  };

  const planReady = pendingDeploy === environment && operation?.kind === "plan" && operation.status === "succeeded";
  const plan = planReady ? (operation?.outcome as PlanOutcome | null | undefined) : undefined;

  return (
    <section className="panel operations">
      <header>
        <h2>Operations on {environment}</h2>
      </header>
      <div className="choice">
        <button type="button" disabled={running} onClick={() => void start("plan")}>
          Plan
        </button>
        <button type="button" disabled={running} onClick={() => void planThenDeploy()}>
          Deploy
        </button>
        <button type="button" className="danger" disabled={running} onClick={() => setConfirmDestroy(true)}>
          Destroy
        </button>
      </div>
      {plan && (
        <div className="confirm">
          <p>
            {renderChanges(plan.changes)} Expected {money(plan.estimate.expected)} a month (low {money(plan.estimate.low)}, high {money(plan.estimate.high)}), or{" "}
            {money(plan.estimate.withFreeTier)} with {plan.estimate.label}.
          </p>
          <div className="choice">
            <button
              type="button"
              onClick={() => {
                setPendingDeploy(undefined);
                void start("deploy");
              }}
            >
              Deploy {environment} now
            </button>
            <button type="button" className="quiet" onClick={() => setPendingDeploy(undefined)}>
              not now
            </button>
          </div>
        </div>
      )}
      {confirmDestroy && (
        <div className="confirm">
          <p>Remove every resource of {environment}? The state bucket stays.</p>
          <div className="choice">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirmDestroy(false);
                void start("destroy");
              }}
            >
              Destroy {environment}
            </button>
            <button type="button" className="quiet" onClick={() => setConfirmDestroy(false)}>
              keep it
            </button>
          </div>
        </div>
      )}
      {failure && <p className="failure">{failure}</p>}
      {operation && (
        <div className={`operation ${operation.status}`}>
          <p>
            <strong>
              {operation.kind} of {operation.environment}
            </strong>{" "}
            {operation.status}
          </p>
          <ol className="events">
            {operation.events.map((event, index) => (
              <li key={index} className={event.phase}>
                {renderProgress(event).trimStart()}
              </li>
            ))}
          </ol>
          {operation.status === "succeeded" && operation.kind === "deploy" && (operation.outcome as DeployOutcome | null)?.apiUrl && (
            <p className="outcome">
              API URL: <a href={(operation.outcome as DeployOutcome).apiUrl}>{(operation.outcome as DeployOutcome).apiUrl}</a>
            </p>
          )}
          {operation.status === "failed" && <pre className="failure">{operation.error}</pre>}
        </div>
      )}
    </section>
  );
}
