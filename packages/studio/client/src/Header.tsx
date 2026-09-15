import type { Blueprint, Diagnostic, Op } from "@hull/blueprint";
import { headerEdit, type Refusal } from "../../src/edits.js";
import { EditableText } from "./EditableText.js";
import { FieldDiagnostics } from "./FieldDiagnostics.js";
import { diagnosticsAt } from "./Inspector.js";

type Props = {
  blueprint: Blueprint;
  diagnostics: Diagnostic[];
  edit: (ops: Op[], path: Op["path"]) => Promise<Refusal>;
};

// The blueprint's header: its name and region, editable as byte-exact
// scalar splices; the provider shown, not editable.
export function Header({ blueprint, diagnostics, edit }: Props) {
  return (
    <header className="blueprint-header">
      <EditableText label="name" value={blueprint.name} onCommit={(value) => edit([headerEdit("name", value)], ["name"])} />
      <FieldDiagnostics refusal={diagnosticsAt(diagnostics, ["name"])} />
      <span className="provider">provider {blueprint.provider}</span>
      <EditableText label="region" value={blueprint.region} onCommit={(value) => edit([headerEdit("region", value)], ["region"])} />
      <FieldDiagnostics refusal={diagnosticsAt(diagnostics, ["region"])} />
    </header>
  );
}
