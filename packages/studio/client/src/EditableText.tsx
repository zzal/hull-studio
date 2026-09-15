import { useEffect, useState, type KeyboardEvent } from "react";
import type { Refusal } from "../../src/edits.js";
import { FieldDiagnostics } from "./FieldDiagnostics.js";
import { useEdit } from "./useEdit.js";

type Props = {
  label: string;
  value: string;
  // Sends the edit; resolves with the refusal to show under the field.
  onCommit: (value: string) => Promise<Refusal>;
  placeholder?: string;
};

// A text field: typed, then committed on Enter or blur. Until the studio
// answers, the field shows the draft; a refused draft stays in the field
// with the diagnostics under it, while the file keeps its old value. Escape
// drops the draft.
export function EditableText({ label, value, onCommit, placeholder }: Props) {
  const [draft, setDraft] = useState(value);
  const { refusal, busy, submit, refuse } = useEdit(onCommit, value);

  useEffect(() => setDraft(value), [value]);

  const drop = () => {
    setDraft(value);
    refuse([]);
  };

  const commit = () => {
    const next = draft.trim();
    if (next === "") refuse(["enter a value"]);
    else if (next === value) drop();
    else void submit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") drop();
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={refusal.length > 0}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <FieldDiagnostics refusal={refusal} />
    </label>
  );
}
