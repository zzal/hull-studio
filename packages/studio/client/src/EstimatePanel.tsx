import { useState } from "react";
import type { EstimateResponse } from "./api.js";

const money = (amount: number) => `$${amount.toFixed(2)}`;

type Props = {
  environments: string[];
  environment: string;
  onEnvironmentChange: (environment: string) => void;
  estimate?: EstimateResponse;
};

// Per intent and in total, low / expected / high a month, with the free
// tier toggled on or off.
export function EstimatePanel({ environments, environment, onEnvironmentChange, estimate }: Props) {
  const [freeTier, setFreeTier] = useState(false);
  const figure = freeTier ? "withFreeTier" : "withoutFreeTier";

  return (
    <section className="panel estimate">
      <header>
        <h2>Estimate</h2>
        <label>
          environment{" "}
          <select value={environment} onChange={(event) => onEnvironmentChange(event.target.value)}>
            {environments.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={freeTier} onChange={(event) => setFreeTier(event.target.checked)} /> with free tier
        </label>
      </header>
      {estimate && (
        <>
          <p className="usage">
            {estimate.usage.requestsPerMonth.toLocaleString("en-US")} requests and {estimate.usage.storageGb} GB a month
            {freeTier && <span className="note"> · {estimate.freeTierLabel}</span>}
          </p>
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
                    <span className="sizing">
                      {Object.entries(intent.sizing)
                        .map(([parameter, { value, source }]) => `${parameter} ${String(value)}${source === "overridden" ? " (override)" : ""}`)
                        .join(", ")}
                    </span>
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
