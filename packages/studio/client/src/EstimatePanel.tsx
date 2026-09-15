import type { Blueprint } from "@hull/blueprint";
import type { Refusal, UsageField } from "../../src/edits.js";
import type { EstimateResponse } from "./api.js";
import { EditableNumber } from "./EditableNumber.js";

const money = (amount: number) => `$${amount.toFixed(2)}`;

type Props = {
  blueprint: Blueprint;
  environment: string;
  onEnvironmentChange: (environment: string) => void;
  estimate?: EstimateResponse;
  freeTier: boolean;
  onFreeTierChange: (freeTier: boolean) => void;
  // Sends a usage profile edit; resolves with the refusal to show under the field.
  onUsageChange: (field: UsageField, value: number, forEnvironment: boolean) => Promise<Refusal>;
};

const usageFields: { field: UsageField; label: string; step: number | "any" }[] = [
  { field: "requestsPerMonth", label: "requests a month", step: 1 },
  { field: "messagesPerMonth", label: "messages a month", step: 1 },
  { field: "storageGb", label: "GB stored", step: "any" },
];

// Per intent and in total, low / expected / high a month, with the free
// tier toggled on or off. The usage profile the figures are relative to is
// editable; a value the environment sets is marked as its own.
export function EstimatePanel({ blueprint, environment, onEnvironmentChange, estimate, freeTier, onFreeTierChange, onUsageChange }: Props) {
  const figure = freeTier ? "withFreeTier" : "withoutFreeTier";
  const ownUsage = blueprint.environments[environment]?.usage ?? {};

  return (
    <section className="panel estimate">
      <header>
        <h2>Estimate</h2>
        <label>
          environment{" "}
          <select value={environment} onChange={(event) => onEnvironmentChange(event.target.value)}>
            {Object.keys(blueprint.environments).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={freeTier} onChange={(event) => onFreeTierChange(event.target.checked)} /> with free tier
        </label>
      </header>
      {estimate && (
        <>
          <div className="usage">
            {usageFields.map(({ field, label, step }) => (
              // Keyed by environment: a draft typed for one is dropped on switching to another.
              <EditableNumber
                key={`${environment}.${field}`}
                label={`${label}${ownUsage[field] !== undefined ? ` (${environment} only)` : ""}`}
                value={estimate.usage[field] ?? 0}
                step={step}
                onCommit={(value) => onUsageChange(field, value, ownUsage[field] !== undefined)}
              />
            ))}
            {freeTier && <p className="note">{estimate.freeTierLabel}</p>}
          </div>
          <table>
            <thead>
              <tr>
                <th>intent</th>
                <th>low</th>
                <th>expected</th>
                <th>high</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(estimate.intents).map(([name, intent]) => (
                <tr key={name}>
                  <td>
                    <strong>{name}</strong>
                    <span className="resolution">{intent.resolution}</span>
                  </td>
                  <td>{money(intent[figure].low)}</td>
                  <td>{money(intent[figure].expected)}</td>
                  <td>{money(intent[figure].high)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>total a month</td>
                <td>{money(estimate.total[figure].low)}</td>
                <td>{money(estimate.total[figure].expected)}</td>
                <td>{money(estimate.total[figure].high)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </section>
  );
}
