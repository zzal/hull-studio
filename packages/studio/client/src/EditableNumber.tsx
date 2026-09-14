import { useEffect, useState, type KeyboardEvent } from "react";
import type { Refusal } from "../../src/edits.js";
import { FieldDiagnostics } from "./FieldDiagnostics.js";
import { useEdit } from "./useEdit.js";

type Props = {
  label: string;
  value: number;
  // Integer fields refuse a decimal in the browser's own validation; the
  // studio refuses it too, with a diagnostic.
  step?: number | "any";
  // Sends the edit; resolves with the refusal to show under the field.
  onCommit: (value: number) => Promise<Refusal>;
};

// A usage profile number: typed, then committed on Enter or blur. Until the
// studio answers, the field shows the draft; a refused draft stays in the
// field with the diagnostics under it, so the developer can fix it, while the
// file keeps its old value. Escape drops the draft.
export function EditableNumber({ label, value, step = 1, onCommit }: Props) {
  const [draft, setDraft] = useState(String(value));
  const { refusal, busy, submit, refuse } = useEdit(onCommit, value);

  // A change from elsewhere (an editor, the studio after another edit)
  // replaces the draft, refused or not: it was written against the old file.
  useEffect(() => setDraft(String(value)), [value]);

  const drop = () => {
    setDraft(String(value));
    refuse([]);
  };

  const commit = () => {
    const next = draft.trim() === "" ? Number.NaN : Number(draft);
    if (Number.isNaN(next)) refuse(["enter a number"]);
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
        type="number"
        min={0}
        step={step}
        value={draft}
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
