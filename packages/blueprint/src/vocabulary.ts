import type { IntentKind, Provider, Role, SizingValue } from "./model.js";

// The primitive a sizing parameter holds, so an override of the wrong shape is
// a load-time diagnostic rather than a surprise downstream.
export type SizingParameterType = "string" | "number" | "boolean";

// The catalog-shaped input validation needs: which resolutions exist, for
// which kind on which provider, with which sizing parameters, and which roles
// each intent kind accepts. The catalog owns the real one; the blueprint
// package only reads it, so the dependency direction holds.
export type Vocabulary = {
  kinds: Record<IntentKind, { roles: readonly Role[] }>;
  resolutions: Record<
    string,
    {
      provider: Provider;
      kind: IntentKind;
      sizingParameters: Readonly<Record<string, SizingParameterType>>;
    }
  >;
};

export function sizingValueHasType(value: SizingValue, type: SizingParameterType): boolean {
  return typeof value === type;
}
