import type { Recommendation } from "@hull/catalog";

const dimensionLabels = {
  cost: "cost at this profile",
  opsBurden: "ops burden",
  scalingCeiling: "scaling ceiling",
  coldStart: "cold start",
} as const;

// The candidates of one intent ranked at the environment's usage profile,
// with the reason per dimension. Proposed, never applied: the blueprint's
// own choice is marked as current.
export function RecommendationCard({ intent, recommendation }: { intent: string; recommendation: Recommendation }) {
  return (
    <section className="panel recommendation">
      <header>
        <h2>Recommendation for {intent}</h2>
        <span className="kind">{recommendation.kind}</span>
      </header>
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
