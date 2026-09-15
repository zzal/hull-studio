import type { Blueprint, Op } from "@hull/blueprint";
import { headerEdit, type Refusal } from "../../src/edits.js";
import { EditableText } from "./EditableText.js";

type Props = {
  blueprint: Blueprint;
  edit: (ops: Op[], path: Op["path"]) => Promise<Refusal>;
};

// The blueprint's header: its name and region, editable as byte-exact
// scalar splices; the provider shown, not editable.
export function Header({ blueprint, edit }: Props) {
  return (
    <header className="blueprint-header">
      <EditableText label="name" value={blueprint.name} onCommit={(value) => edit([headerEdit("name", value)], ["name"])} />
      <span className="provider">provider {blueprint.provider}</span>
      <EditableText label="region" value={blueprint.region} onCommit={(value) => edit([headerEdit("region", value)], ["region"])} />
    </header>
  );
}
