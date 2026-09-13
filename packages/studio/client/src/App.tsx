import type { Blueprint, Diagnostic } from "@hull/blueprint";
import { useEffect, useState } from "react";
import {
  listenForChanges,
  readBlueprint,
  readEstimate,
  readRecommendations,
  RouteError,
  type EstimateResponse,
  type RecommendationsResponse,
} from "./api.js";
import { DiagnosticsBanner } from "./DiagnosticsBanner.js";
import { EstimatePanel } from "./EstimatePanel.js";
import { Graph } from "./Graph.js";
import { RecommendationCard } from "./RecommendationCard.js";

const defaultEnvironment = "dev";

// The dashboard: the graph of intents and links, the estimate for one
// environment, the recommendations for it. Everything is refetched on the
// studio's "changed" signal, so an edit in an IDE shows within a second. A
// broken edit shows its diagnostics in a banner over the last valid model,
// which stays until the file is valid again.
export function App() {
  const [blueprint, setBlueprint] = useState<Blueprint>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [environment, setEnvironment] = useState(defaultEnvironment);
  const [estimate, setEstimate] = useState<EstimateResponse>();
  const [recommendations, setRecommendations] = useState<RecommendationsResponse>();
  const [failure, setFailure] = useState<string>();
  // Bumped on every "changed" signal; the load below reruns on it.
  const [version, setVersion] = useState(0);

  useEffect(() => listenForChanges(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    // A load overtaken by a newer one, or by an environment switch, must not
    // land its stale answers.
    let stale = false;
    const load = async () => {
      try {
        const result = await readBlueprint();
        if (stale) return;
        setFailure(undefined);
        setDiagnostics(result.diagnostics);
        if (!result.blueprint) return;
        setBlueprint(result.blueprint);
        const environments = Object.keys(result.blueprint.environments);
        if (!environments.includes(environment)) {
          // The chosen environment is gone from the file; the switch reruns this load.
          if (environments[0] !== undefined) setEnvironment(environments[0]);
          return;
        }
        const [nextEstimate, nextRecommendations] = await Promise.all([
          readEstimate(environment),
          readRecommendations(environment),
        ]);
        if (stale) return;
        setEstimate(nextEstimate);
        setRecommendations(nextRecommendations);
      } catch (error) {
        if (stale) return;
        setFailure(error instanceof RouteError ? error.response.error : "the studio is not answering");
      }
    };
    void load();
    return () => {
      stale = true;
    };
  }, [version, environment]);

  return (
    <main className="studio">
      <header>
        <h1>{blueprint?.name ?? "Hull studio"}</h1>
        {blueprint && (
          <span className="provider">
            {blueprint.provider} · {blueprint.region}
          </span>
        )}
      </header>
      <div className="notices">
        {diagnostics.length > 0 && <DiagnosticsBanner diagnostics={diagnostics} />}
        {failure && <p className="failure">{failure}</p>}
      </div>
      <section className="graph">
        {blueprint && <Graph blueprint={blueprint} recommendations={recommendations} />}
      </section>
      <aside className="panels">
        {blueprint && (
          <EstimatePanel
            environments={Object.keys(blueprint.environments)}
            environment={environment}
            onEnvironmentChange={setEnvironment}
            estimate={estimate}
          />
        )}
        {recommendations &&
          Object.entries(recommendations.intents).map(([intent, recommendation]) => (
            <RecommendationCard key={intent} intent={intent} recommendation={recommendation} />
          ))}
      </aside>
    </main>
  );
}
