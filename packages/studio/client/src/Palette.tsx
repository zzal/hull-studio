import type { IntentKind } from "@hull/blueprint";
import type { CatalogResponse } from "./api.js";

type Props = {
  catalog: CatalogResponse;
  busy: boolean;
  onAdd: (kind: IntentKind, resolution: string) => void;
};

// The four kinds; adding one writes the intent with its recommended
// resolution at the environment's usage profile and selects it.
export function Palette({ catalog, busy, onAdd }: Props) {
  return (
    <section className="panel palette">
      <header>
        <h2>Add an intent</h2>
      </header>
      <div className="kinds">
        {(Object.entries(catalog.kinds) as [IntentKind, CatalogResponse["kinds"][IntentKind]][]).map(([kind, { recommended }]) => (
          <button key={kind} type="button" disabled={busy} title={`on ${recommended}`} onClick={() => onAdd(kind, recommended)}>
            + {kind}
          </button>
        ))}
      </div>
    </section>
  );
}
