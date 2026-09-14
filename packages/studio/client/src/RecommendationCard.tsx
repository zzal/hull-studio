import type { Recommendation } from "@hull/catalog";
import type { Refusal } from "../../src/edits.js";
import { FieldDiagnostics } from "./FieldDiagnostics.js";
import { useEdit } from "./useEdit.js";

const dimensionLabels = {
  cost: "cost at this profile",
  opsBurden: "ops burden",
  scalingCeiling: "scaling ceiling",
  coldStart: "cold start",
} as const;

type Props = {
  intent: string;
  recommendation: Recommendation;
  // Sends the resolution edit; resolves with the refusal to show under the picker.
  onResolutionChange: (resolution: string) => Promise<Refusal>;
};

// The candidates of one intent ranked at the environment's usage profile,
// with the reason per dimension. Proposed, never applied by the catalog:
// the developer picks a candidate, or accepts the recommended one in one
// click, and that changes the resolution line in the file.
export function RecommendationCard({ intent, recommendation, onResolutionChange }: Props) {
  const { refusal, busy, submit } = useEdit(onResolutionChange, recommendation.current);
  const choose = (resolution: string) => {
    if (resolution !== recommendation.current) void submit(resolution);
  };

  return (
    <section className="panel recommendation">
      <header>
        <h2>Recommendation for {intent}</h2>
        <span className="kind">{recommendation.kind}</span>
      </header>
      <div className="choice">
        <label>
          resolution{" "}
          <select value={recommendation.current} disabled={busy} onChange={(event) => choose(event.target.value)}>
            {recommendation.ranking.map((candidate) => (
              <option key={candidate.resolution} value={candidate.resolution}>
                {candidate.resolution}
              </option>
            ))}
          </select>
        </label>
        {recommendation.recommended !== recommendation.current && (
          <button type="button" disabled={busy} onClick={() => choose(recommendation.recommended)}>
            Accept {recommendation.recommended}
          </button>
        )}
      </div>
      <FieldDiagnostics refusal={refusal} />
      <ol>
        {recommendation.ranking.map((candidate) => (
          <li key={candidate.resolution} className={candidate.resolution === recommendation.recommended ? "recommended" : undefined}>
            <div className="candidate">
              <strong>{candidate.resolution}</strong>
              {candidate.resolution === recommendation.current && <span className="tag">current</span>}
              {candidate.resolution === recommendation.recommended && <span className="tag">recommended</span>}
            </div>
            <dl>
              {(Object.keys(dimensionLabels) as (keyof typeof dimensionLabels)[]).map((dimension) => (
                <div key={dimension}>
                  <dt>{dimensionLabels[dimension]}</dt>
                  <dd>{candidate.reasons[dimension]}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}
