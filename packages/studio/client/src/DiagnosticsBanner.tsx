import type { Diagnostic } from "@hull/blueprint";

// A broken hand edit, visible without opening a terminal.
export function DiagnosticsBanner({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <div className="banner" role="alert">
      <strong>hull.yaml is not valid</strong>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={index}>
            {diagnostic.path.length > 0 && <code>{diagnostic.path.join(".")}</code>} {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
