import { isTier, type Blueprint, type Diagnostic, type Op, type SizingValue } from "@hull/blueprint";
import type { Recommendation, SizingParameterFacts } from "@hull/catalog";
import { useState } from "react";
import {
  entryEdit,
  overrideEdit,
  removeIntentEdit,
  removeLinkEdit,
  renameIntentEdit,
  resetOverrideEdit,
  resolutionEdit,
  type Refusal,
} from "../../src/edits.js";
import { money } from "../../src/format.js";
import type { CatalogResponse, EstimateResponse, RecommendationsResponse } from "./api.js";
import { EditableText } from "./EditableText.js";
import { FieldDiagnostics } from "./FieldDiagnostics.js";
import type { Selection } from "./Graph.js";
import { useEdit } from "./useEdit.js";


const dimensionLabels: Record<string, string> = {
  cost: "cost at this profile",
  opsBurden: "ops burden",
  scalingCeiling: "scaling ceiling",
  coldStart: "cold start",
  jobDuration: "job duration",
};

type Edit = (ops: Op[], path: Op["path"]) => Promise<Refusal>;

type Props = {
  blueprint: Blueprint;
  selection: Selection;
  // The file's own diagnostics, shown beside the field each concerns.
  diagnostics: Diagnostic[];
  environment: string;
  estimate?: EstimateResponse;
  recommendations?: RecommendationsResponse;
  catalog?: CatalogResponse;
  freeTier: boolean;
  edit: Edit;
  onSelect: (selection: Selection | undefined) => void;
};

// The file's diagnostics at a path, as the refusal lines a field shows.
export function diagnosticsAt(diagnostics: Diagnostic[], path: Op["path"]): string[] {
  const key = path.join(".");
  return diagnostics.filter((diagnostic) => diagnostic.path.join(".") === key).map((diagnostic) => diagnostic.message);
}

// Everything about the selected intent or link, editable in place: the
// graph is where the blueprint is edited, not a picture.
export function Inspector(props: Props) {
  return props.selection.type === "intent" ? <IntentInspector {...props} selection={props.selection} /> : <LinkInspector {...props} selection={props.selection} />;
}

function LinkInspector({ blueprint, selection, edit, onSelect }: Props & { selection: Extract<Selection, { type: "link" }> }) {
  const tier = blueprint.intents[selection.tier];
  const link = tier && isTier(tier) ? tier.links?.[selection.index] : undefined;
  const { refusal, busy, submit } = useEdit(async () => {
    const result = await edit([removeLinkEdit(selection.tier, selection.index)], ["intents", selection.tier, "links", selection.index]);
    if (result.length === 0) onSelect(undefined);
    return result;
  }, link);
  if (!link) return null;
  return (
    <section className="panel inspector">
      <header>
        <h2>Link</h2>
      </header>
      <dl className="facts">
        <div>
          <dt>from</dt>
          <dd>{selection.tier}</dd>
        </div>
        <div>
          <dt>to</dt>
          <dd>{link.to}</dd>
        </div>
        <div>
          <dt>role</dt>
          <dd>{link.role}</dd>
        </div>
      </dl>
      <button type="button" className="danger" disabled={busy} onClick={() => void submit(undefined)}>
        Remove this link
      </button>
      <FieldDiagnostics refusal={refusal} />
    </section>
  );
}

function IntentInspector({ blueprint, selection, diagnostics, environment, estimate, recommendations, catalog, freeTier, edit, onSelect }: Props & { selection: Extract<Selection, { type: "intent" }> }) {
  const { name } = selection;
  const intent = blueprint.intents[name];
  if (!intent) return null;
  const candidates = catalog?.kinds[intent.kind]?.candidates ?? [];
  const recommendation = recommendations?.intents[name];
  const estimated = estimate?.intents[name];
  const figure = freeTier ? "withFreeTier" : "withoutFreeTier";
  const linkedFrom = Object.entries(blueprint.intents).flatMap(([tierName, tier]) =>
    isTier(tier) ? (tier.links ?? []).flatMap((link, index) => (link.to === name ? [{ tierName, index, role: link.role }] : [])) : [],
  );

  return (
    <section className="panel inspector">
      <header>
        <h2>{name}</h2>
        <span className="kind">{intent.kind}</span>
      </header>

      <EditableText
        label="name"
        value={name}
        onCommit={async (value) => {
          const result = await edit(renameIntentEdit(blueprint, name, value), ["intents", value]);
          if (result.length === 0) onSelect({ type: "intent", name: value });
          return result;
        }}
      />
      <FieldDiagnostics refusal={diagnosticsAt(diagnostics, ["intents", name])} />

      <ResolutionField
        intent={name}
        current={intent.resolution}
        candidates={candidates}
        recommendation={recommendation}
        fileDiagnostics={diagnosticsAt(diagnostics, ["intents", name, "resolution"])}
        edit={edit}
      />

      {isTier(intent) && (
        <>
          <EditableText label="entry" value={intent.entry} onCommit={(value) => edit([entryEdit(name, value)], ["intents", name, "entry"])} />
          <FieldDiagnostics refusal={diagnosticsAt(diagnostics, ["intents", name, "entry"])} />
        </>
      )}

      {isTier(intent) && (
        <div className="links">
          <h3>Links</h3>
          {(intent.links ?? []).length === 0 && <p className="note">No links yet; drag from this node to a queue or a database.</p>}
          <ul>
            {(intent.links ?? []).map((link, index) => (
              <li key={index}>
                <button type="button" className="quiet" onClick={() => onSelect({ type: "link", tier: name, index })}>
                  {link.role} → {link.to}
                </button>
                <FieldDiagnostics refusal={diagnostics.filter((d) => d.path.slice(0, 4).join(".") === ["intents", name, "links", index].join(".")).map((d) => d.message)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {linkedFrom.length > 0 && (
        <div className="links">
          <h3>Linked from</h3>
          <ul>
            {linkedFrom.map(({ tierName, index, role }) => (
              <li key={`${tierName}-${index}`}>
                <button type="button" className="quiet" onClick={() => onSelect({ type: "link", tier: tierName, index })}>
                  {tierName} ({role})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {estimated && (
        <SizingSection
          intent={name}
          environment={environment}
          sizing={estimated.sizing}
          parameters={candidates.find((candidate) => candidate.resolution === intent.resolution)?.sizingParameters ?? {}}
          diagnostics={diagnostics}
          edit={edit}
        />
      )}

      {estimated && (
        <div className="deploys">
          <h3>What this deploys</h3>
          {!estimated.deployable && <p className="note">{intent.resolution} is priced and compared, but not deployable in this version.</p>}
          <table>
            <thead>
              <tr>
                <th>resource</th>
                <th>low</th>
                <th>expected</th>
                <th>high</th>
              </tr>
            </thead>
            <tbody>
              {estimated.resources.map((resource) => (
                <tr key={resource.resource}>
                  <td>{resource.resource}</td>
                  {resource[figure].expected === 0 && resource[figure].high === 0 ? (
                    <td colSpan={3} className="no-charge">
                      no charge
                    </td>
                  ) : (
                    <>
                      <td>{money(resource[figure].low)}</td>
                      <td>{money(resource[figure].expected)}</td>
                      <td>{money(resource[figure].high)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>{name} a month</td>
                <td>{money(estimated[figure].low)}</td>
                <td>{money(estimated[figure].expected)}</td>
                <td>{money(estimated[figure].high)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <RemoveIntent blueprint={blueprint} intent={name} edit={edit} onRemoved={() => onSelect(undefined)} />
    </section>
  );
}

type ResolutionProps = {
  intent: string;
  current: string;
  candidates: CatalogResponse["kinds"][keyof CatalogResponse["kinds"]]["candidates"];
  recommendation?: Recommendation;
  fileDiagnostics: string[];
  edit: Edit;
};

// The resolution as a dropdown of the kind's candidates, with the
// recommendation's ranked reasons inline. Proposed, never applied by the
// catalog: the developer picks, and that changes the resolution line.
function ResolutionField({ intent, current, candidates, recommendation, fileDiagnostics, edit }: ResolutionProps) {
  const { refusal, busy, submit } = useEdit((resolution: string) => edit([resolutionEdit(intent, resolution)], ["intents", intent, "resolution"]), current);
  const choose = (resolution: string) => {
    if (resolution !== current) void submit(resolution);
  };
  return (
    <div className="resolution-field">
      <label className="field">
        <span>resolution</span>
        <select value={current} disabled={busy} onChange={(event) => choose(event.target.value)}>
          {candidates.map((candidate) => (
            <option key={candidate.resolution} value={candidate.resolution}>
              {candidate.resolution}
              {candidate.deployable ? "" : " (not deployable in this version)"}
            </option>
          ))}
        </select>
        <FieldDiagnostics refusal={[...fileDiagnostics, ...refusal]} />
      </label>
      {recommendation && (
        <div className="recommendation">
          {recommendation.recommended !== current && (
            <button type="button" disabled={busy} onClick={() => choose(recommendation.recommended)}>
              Accept {recommendation.recommended}
            </button>
          )}
          <ol>
            {recommendation.ranking.map((candidate) => (
              <li key={candidate.resolution} className={candidate.resolution === recommendation.recommended ? "recommended" : undefined}>
                <div className="candidate">
                  <strong>{candidate.resolution}</strong>
                  {candidate.resolution === current && <span className="tag">current</span>}
                  {candidate.resolution === recommendation.recommended && <span className="tag">recommended</span>}
                </div>
                <dl>
                  {recommendation.dimensions.map((dimension) => (
                    <div key={dimension}>
                      <dt>{dimensionLabels[dimension] ?? dimension}</dt>
                      <dd>{candidate.reasons[dimension]}</dd>
                    </div>
                  ))}
                  <CandidateResources facts={candidates.find((facts) => facts.resolution === candidate.resolution)} />
                </dl>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// What a candidate deploys, from the catalog, and whether this version
// deploys it at all: the comparison sits where the decision is made.
function CandidateResources({ facts }: { facts?: CatalogResponse["kinds"][keyof CatalogResponse["kinds"]]["candidates"][number] }) {
  if (!facts) return null;
  return (
    <div>
      <dt>deploys</dt>
      <dd>
        {facts.resources.join(", ")}
        {!facts.deployable && <em className="note"> (not deployable in this version)</em>}
      </dd>
    </div>
  );
}

type SizingProps = {
  intent: string;
  environment: string;
  sizing: EstimateResponse["intents"][string]["sizing"];
  parameters: Record<string, SizingParameterFacts>;
  diagnostics: Diagnostic[];
  edit: Edit;
};

// Every sizing value for the selected environment, editable: an edit writes
// an override, shown as overridden beside the derived value; a reset removes
// it and the mappings it leaves empty.
function SizingSection({ intent, environment, sizing, parameters, diagnostics, edit }: SizingProps) {
  return (
    <div className="sizing">
      <h3>Sizing for {environment}</h3>
      {Object.entries(sizing).map(([parameter, { value, source }]) => (
        <SizingField
          key={`${environment}.${intent}.${parameter}`}
          parameter={parameter}
          value={value}
          source={source}
          facts={parameters[parameter]}
          fileDiagnostics={diagnosticsAt(diagnostics, ["environments", environment, "overrides", intent, parameter])}
          onCommit={(next) => edit([overrideEdit(environment, intent, parameter, next)], ["environments", environment, "overrides", intent, parameter])}
          onReset={() => edit([resetOverrideEdit(environment, intent, parameter)], ["environments", environment, "overrides", intent, parameter])}
        />
      ))}
    </div>
  );
}

type SizingFieldProps = {
  parameter: string;
  value: SizingValue;
  source: "derived" | "overridden";
  facts?: SizingParameterFacts;
  fileDiagnostics: string[];
  onCommit: (value: SizingValue) => Promise<Refusal>;
  onReset: () => Promise<Refusal>;
};

function SizingField({ parameter, value, source, facts, fileDiagnostics, onCommit, onReset }: SizingFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const { refusal, busy, submit, refuse } = useEdit(onCommit, value);
  const reset = useEdit(onReset, value);
  const type = facts?.type ?? typeof value;

  const commit = () => {
    if (type === "number") {
      const next = draft.trim() === "" ? Number.NaN : Number(draft);
      if (Number.isNaN(next)) refuse(["enter a number"]);
      else if (next !== value) void submit(next);
    } else if (draft !== String(value)) void submit(draft);
  };

  return (
    <div className="sizing-field">
      <label className="field">
        <span>
          {parameter} <em className={source}>{source}</em>
        </span>
        {facts?.choices ? (
          <select value={String(value)} disabled={busy} onChange={(event) => void submit(event.target.value)}>
            {facts.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : type === "boolean" ? (
          <select value={String(value)} disabled={busy} onChange={(event) => void submit(event.target.value === "true")}>
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        ) : (
          <input
            type={type === "number" ? "number" : "text"}
            value={draft}
            disabled={busy}
            aria-invalid={refusal.length > 0}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDraft(String(value));
            }}
          />
        )}
      </label>
      {source === "overridden" && (
        <button type="button" className="quiet" disabled={reset.busy} onClick={() => void reset.submit(undefined)}>
          reset to derived
        </button>
      )}
      <FieldDiagnostics refusal={[...fileDiagnostics, ...refusal, ...reset.refusal]} />
    </div>
  );
}

function RemoveIntent({ blueprint, intent, edit, onRemoved }: { blueprint: Blueprint; intent: string; edit: Edit; onRemoved: () => void }) {
  const { refusal, busy, submit } = useEdit(async () => {
    const result = await edit(removeIntentEdit(blueprint, intent), ["intents", intent]);
    if (result.length === 0) onRemoved();
    return result;
  }, intent);
  return (
    <div className="remove">
      <button type="button" className="danger" disabled={busy} onClick={() => void submit(undefined)}>
        Remove {intent}
      </button>
      <FieldDiagnostics refusal={refusal} />
    </div>
  );
}
