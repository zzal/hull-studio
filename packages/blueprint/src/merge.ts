import type { Blueprint, Intent, SizingValue, UsageProfile } from "./model.js";

// A sizing value in one environment, marked so an override never passes for a
// derived value in any view (CONTEXT.md: Override).
export type MergedSizingValue = { value: SizingValue; source: "derived" | "overridden" };
export type MergedSizing = Record<string, MergedSizingValue>;

export type MergedIntent = Intent & { sizing: MergedSizing };

// The blueprint merged for one environment: the single input to sizing,
// estimate and deploy, so what the studio shows for dev is what deploys to dev.
export type MergedBlueprint = {
  name: string;
  provider: Blueprint["provider"];
  region: string;
  environment: string;
  usage: UsageProfile;
  intents: Record<string, MergedIntent>;
};

// Sizing derivation belongs to the catalog; the blueprint package only calls it.
export type DeriveSizing = (resolution: string, usage: UsageProfile) => Record<string, SizingValue>;

// Merge order: base usage profile, then the environment's usage profile, then
// the environment's overrides on top of the sizing derived from that usage.
// Returns undefined when the blueprint has no such environment.
export function mergeEnvironment(
  blueprint: Blueprint,
  environmentName: string,
  deriveSizing: DeriveSizing,
): MergedBlueprint | undefined {
  const environment = blueprint.environments[environmentName];
  if (!environment) return undefined;

  const usage: UsageProfile = { ...blueprint.usage, ...definedEntries(environment.usage ?? {}) };

  const intents = Object.fromEntries(
    Object.entries(blueprint.intents).map(([name, intent]) => {
      const derived = deriveSizing(intent.resolution, usage);
      const overrides = environment.overrides?.[name] ?? {};
      // Every override survives, even for a parameter derivation left out:
      // a pin the developer wrote must never vanish into a no-op.
      const parameters = new Set([...Object.keys(derived), ...Object.keys(overrides)]);
      const sizing: MergedSizing = {};
      for (const parameter of parameters) {
        sizing[parameter] =
          parameter in overrides
            ? { value: overrides[parameter] as SizingValue, source: "overridden" }
            : { value: derived[parameter] as SizingValue, source: "derived" };
      }
      return [name, { ...intent, sizing }];
    }),
  );

  return {
    name: blueprint.name,
    provider: blueprint.provider,
    region: blueprint.region,
    environment: environmentName,
    usage,
    intents,
  };
}

// The plain sizing, marks dropped, for consumers that only need the values.
export function sizingValues(sizing: MergedSizing): Record<string, SizingValue> {
  return Object.fromEntries(Object.entries(sizing).map(([parameter, { value }]) => [parameter, value]));
}

// An environment's partial usage profile parsed from YAML never carries
// explicit undefined values, but the type allows them, and a spread of
// `{ storageGb: undefined }` would erase the base value.
function definedEntries<T extends object>(partial: T): Partial<T> {
  return Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined)) as Partial<T>;
}
