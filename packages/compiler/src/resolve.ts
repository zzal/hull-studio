import { mergeEnvironment, type Blueprint, type MergedBlueprint } from "@hull/blueprint";
import { deriveSizing } from "@hull/catalog";

// The catalog's part of loading a blueprint for deploy, so a caller that must
// not know the catalog (the CLI) still gets exactly what the studio shows:
// the vocabulary the blueprint is validated against, and the environment
// merge with derived sizing. Pulumi-free.

export { vocabulary } from "@hull/catalog";

// The blueprint merged for one environment with derived sizing, or
// undefined when the blueprint has no such environment.
export function resolveEnvironment(blueprint: Blueprint, environment: string): MergedBlueprint | undefined {
  return mergeEnvironment(blueprint, environment, deriveSizing);
}
