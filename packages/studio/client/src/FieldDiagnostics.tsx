import type { Refusal } from "../../src/edits.js";

// The studio's diagnostics for a refused edit, next to the field it refused.
export function FieldDiagnostics({ refusal }: { refusal: Refusal }) {
  if (refusal.length === 0) return null;
  return (
    <ul className="field-diagnostics" role="alert">
      {refusal.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
