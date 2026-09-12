import type { IntentKind, Provider, Role } from "./model.js";

// The catalog-shaped input validation needs: which resolutions exist, for
// which kind on which provider, with which sizing parameters, and which roles
// each intent kind accepts. The catalog owns the real one; the blueprint
// package only reads it, so the dependency direction holds.
export type Vocabulary = {
  kinds: Record<IntentKind, { roles: readonly Role[] }>;
  resolutions: Record<
    string,
    { provider: Provider; kind: IntentKind; sizingParameters: readonly string[] }
  >;
};
