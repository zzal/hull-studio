# PROTOTYPE: yaml round trip (spike 1 of milestone 1)

Throwaway. Answers one question:

> Can Hull edit `hull.yaml` programmatically with the `yaml` package
> (eemeli, v2.8) so that a diff touches only the edited lines and comments
> survive?

Run: `pnpm install && pnpm run check` (non-interactive) or `pnpm start`
(interactive, pushes the harder cases: new key, delete key, fill `{}`,
append to a sequence, keys with trailing comments).

## Verdict: yes, with a hybrid

- `Document.toString()` alone is **not** byte-exact on a hand-formatted
  file. It normalizes spacing before trailing comments (`a   # c` becomes
  `a # c`) and moves a comment placed after a mapping key (`usage:   # c`)
  onto its own line. Comments themselves are never lost. The normalized
  form is idempotent (a second pass is byte-identical).
- Replacing the value of an **existing plain scalar** by its source range
  (`node.range` from `parseDocument`) is byte-exact on any file. The two
  edits named in the spike produce exactly 4 changed lines (2 removed,
  2 added).
- **Structural edits** (new key, delete key, append to a sequence, fill an
  empty flow mapping) go through the Document API. On a file already in
  canonical form they touch only the affected lines. On a hand-formatted
  file the first structural edit also applies the one-time normalization
  above.
- Two quirks to handle in the real code: deleting the last key of a
  mapping leaves `{}` behind (decide whether to drop the now-empty
  parent), and `setIn` into `dev: {}` keeps flow style unless `flow` is
  reset to false on the created nodes (done in `patch.ts`).

Decision for `@hull/blueprint`: scalar edits by range splice, structural
edits by Document API, and `hull init` writes the canonical form so files
Hull created never see the normalization diff.
