import type { Blueprint, Diagnostic, IntentKind, Op } from "@hull/blueprint";
import { useCallback, useEffect, useState } from "react";
import { addIntentEdit, addLinkEdit, environmentUsageEdit, refusalAt, usageEdit, type Refusal, type UsageField } from "../../src/edits.js";
import {
  listenForChanges,
  patchBlueprint,
  readBlueprint,
  readCatalog,
  readCurrentOperation,
  readEstimate,
  readRecommendations,
  RouteError,
  startOperation,
  type CatalogResponse,
  type EstimateResponse,
  type Operation,
  type OperationKind,
  type RecommendationsResponse,
} from "./api.js";
import { DiagnosticsBanner } from "./DiagnosticsBanner.js";
import { EstimatePanel } from "./EstimatePanel.js";
import { Graph, type Selection } from "./Graph.js";
import { Header } from "./Header.js";
import { Inspector } from "./Inspector.js";
import { OperationsPanel } from "./OperationsPanel.js";
import { Palette } from "./Palette.js";
import { RolePicker } from "./RolePicker.js";
import { StartScreen } from "./StartScreen.js";

const defaultEnvironment = "dev";

// The dashboard: the graph of intents and links, the inspector for the
// selection, the estimate for one environment, and the operations on it.
// Everything is refetched on the studio's "changed" signal, so an edit in
// an IDE shows within a second. A broken edit shows its diagnostics in a
// banner over the last valid model, which stays until the file is valid
// again. Every edit is one patch; the studio writes the file, and the
// signal brings the new figures back like any other edit.
export function App() {
  const [missing, setMissing] = useState(false);
  const [blueprint, setBlueprint] = useState<Blueprint>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [environment, setEnvironment] = useState(defaultEnvironment);
  const [freeTier, setFreeTier] = useState(false);
  const [estimate, setEstimate] = useState<EstimateResponse>();
  const [recommendations, setRecommendations] = useState<RecommendationsResponse>();
  const [catalog, setCatalog] = useState<CatalogResponse>();
  const [selection, setSelection] = useState<Selection>();
  const [pendingLink, setPendingLink] = useState<{ tier: string; to: string }>();
  const [operation, setOperation] = useState<Operation>();
  const [failure, setFailure] = useState<string>();
  // Bumped on every "changed" signal; the load below reruns on it.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(
    () =>
      listenForChanges({
        onChanged: reload,
        onOperation: ({ operation: next, progress }) =>
          setOperation((current) => ({
            ...next,
            // The events accumulate here; the studio sends them one at a time.
            events: current && current.id === next.id ? [...current.events, ...(progress ? [progress] : [])] : progress ? [progress] : [],
          })),
      }),
    [reload],
  );

  // The operation running when the dashboard opened, with its events so far.
  useEffect(() => {
    readCurrentOperation().then((current) => current && setOperation(current), () => undefined);
  }, []);

  // A list of operations, sent as one patch: resolves with the refusal to
  // show next to the field, nothing when the studio accepted it. The reload
  // is not left to the file watcher alone, so the figures update even when
  // the signal is late.
  const edit = useCallback(
    async (ops: Op[], path: Op["path"]): Promise<Refusal> => {
      try {
        await patchBlueprint(ops);
        reload();
        return [];
      } catch (error) {
        return error instanceof RouteError ? refusalAt(path, error.response) : ["the studio is not answering"];
      }
    },
    [reload],
  );

  useEffect(() => {
    // A load overtaken by a newer one, or by an environment switch, must not
    // land its stale answers.
    let stale = false;
    const load = async () => {
      try {
        const result = await readBlueprint();
        if (stale) return;
        setMissing(false);
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
        const [nextEstimate, nextRecommendations, nextCatalog] = await Promise.all([
          readEstimate(environment).catch((error: unknown) => {
            // A sizing the catalog cannot price: the figures stay stale and the banner says why.
            if (error instanceof RouteError) setFailure(error.response.error);
            return undefined;
          }),
          readRecommendations(environment).catch(() => undefined),
          readCatalog(environment),
        ]);
        if (stale) return;
        if (nextEstimate) setEstimate(nextEstimate);
        setRecommendations(nextRecommendations);
        setCatalog(nextCatalog);
      } catch (error) {
        if (stale) return;
        if (error instanceof RouteError && error.status === 404 && !blueprint) setMissing(true);
        else setFailure(error instanceof RouteError ? error.response.error : "the studio is not answering");
      }
    };
    void load();
    return () => {
      stale = true;
    };
    // The blueprint itself is only read here, never a reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, environment]);

  const addIntent = async (kind: IntentKind, resolution: string) => {
    if (!blueprint) return;
    const { name, op } = addIntentEdit(blueprint, kind, resolution);
    const refused = await edit([op], ["intents", name]);
    if (refused.length === 0) setSelection({ type: "intent", name });
    else setFailure(refused.join("; "));
  };

  const pickRole = async (role: string) => {
    if (!blueprint || !pendingLink) return;
    const { tier, to } = pendingLink;
    setPendingLink(undefined);
    const op = addLinkEdit(blueprint, tier, to, role);
    const refused = await edit([op], op.path);
    if (refused.length === 0) setSelection({ type: "link", tier, index: op.path[3] as number });
    else setFailure(refused.join("; "));
  };

  const start = async (kind: OperationKind): Promise<string | undefined> => {
    try {
      const started = await startOperation(kind, environment);
      // The WebSocket may already have carried the operation further, even
      // to its end, before this answer arrived: never go back.
      setOperation((current) => (current && current.id === started.id ? current : started));
      return undefined;
    } catch (error) {
      return error instanceof RouteError ? error.response.error : "the studio is not answering";
    }
  };

  if (missing) return <StartScreen onCreated={reload} />;

  const busy = operation?.status === "running";

  return (
    <main className="studio">
      <header>
        <h1>{blueprint?.name ?? "Hull studio"}</h1>
        {blueprint && <Header blueprint={blueprint} diagnostics={diagnostics} edit={edit} />}
      </header>
      <div className="notices">
        {diagnostics.length > 0 && <DiagnosticsBanner diagnostics={diagnostics} />}
        {failure && <p className="failure">{failure}</p>}
        {busy && <p className="running">A {operation?.kind} of {operation?.environment} is running; the blueprint cannot change until it ends.</p>}
      </div>
      <section className="graph">
        {blueprint && (
          <Graph
            blueprint={blueprint}
            recommendations={recommendations}
            selection={selection}
            onSelect={(next) => {
              setSelection(next);
              setPendingLink(undefined);
            }}
            onConnect={(tier, to) => setPendingLink({ tier, to })}
          />
        )}
      </section>
      <aside className="panels">
        {blueprint && catalog && pendingLink && (
          <RolePicker
            tier={pendingLink.tier}
            to={pendingLink.to}
            roles={catalog.kinds[blueprint.intents[pendingLink.to]!.kind].roles}
            onPick={(role) => void pickRole(role)}
            onCancel={() => setPendingLink(undefined)}
          />
        )}
        {blueprint && selection && (
          <Inspector
            blueprint={blueprint}
            selection={selection}
            diagnostics={diagnostics}
            environment={environment}
            estimate={estimate}
            recommendations={recommendations}
            catalog={catalog}
            freeTier={freeTier}
            edit={edit}
            onSelect={setSelection}
          />
        )}
        {blueprint && catalog && <Palette catalog={catalog} busy={busy} onAdd={(kind, resolution) => void addIntent(kind, resolution)} />}
        {blueprint && (
          <EstimatePanel
            blueprint={blueprint}
            environment={environment}
            onEnvironmentChange={setEnvironment}
            estimate={estimate}
            freeTier={freeTier}
            onFreeTierChange={setFreeTier}
            onUsageChange={(field: UsageField, value: number, forEnvironment: boolean) =>
              edit([forEnvironment ? environmentUsageEdit(environment, field, value) : usageEdit(blueprint, environment, field, value)], ["usage", field])
            }
          />
        )}
        {blueprint && <OperationsPanel environment={environment} operation={operation} onStart={start} />}
      </aside>
    </main>
  );
}
