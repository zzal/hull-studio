# Resolution is pinned in the blueprint

Each intent's chosen resolution is written into the blueprint next to the intent, rather than computed at deploy time from the catalog's current rules. Deploys are deterministic and a catalog update never changes existing infrastructure; when a better resolution appears, the studio proposes it as a recommendation the developer accepts or dismisses.

## Considered Options

- Intent only, resolved at deploy: Encore's model, and its main complaint (a tool upgrade produces a surprise diff).
- Separate lock file: same determinism, but developer overrides ("I want Aurora") would have nowhere clean to live, since nobody should hand-edit a lock file.
