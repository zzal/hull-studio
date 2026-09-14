import { useEffect, useState } from "react";
import type { Refusal } from "../../src/edits.js";

// One editable field's exchange with the studio: sending, and the refusal to
// show until the next attempt. A refusal is about the file as it was; when
// the field's value changes underneath (the studio wrote the file, or an
// editor did) the refusal is cleared with it.
export function useEdit<T>(send: (value: T) => Promise<Refusal>, current: unknown) {
  const [refusal, setRefusal] = useState<Refusal>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => setRefusal([]), [current]);

  const submit = async (value: T) => {
    setBusy(true);
    try {
      setRefusal(await send(value));
    } finally {
      setBusy(false);
    }
  };

  return { refusal, busy, submit, refuse: setRefusal };
}
