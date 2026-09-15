import { z } from "zod";

// Blueprint v0: what the milestone 1 proof of concept needs plus milestone
// 2's queue and background worker, in Hull's own vocabulary (CONTEXT.md).
// Resolution names are the only provider-specific values, by definition, and
// are validated against the catalog vocabulary at load time rather than
// enumerated here.

// Intent names become environment variable prefixes (HULL_<INTENT>_...) in
// the link contract, so they are limited to what a variable name accepts.
const intentName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "intent names must be lower-case letters, digits or underscores, starting with a letter",
  );

function strictObject<T extends z.ZodRawShape>(shape: T) {
  const allowed = Object.keys(shape).join(", ");
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `unexpected key ${issue.keys.map((key) => `"${key}"`).join(", ")}; allowed keys are ${allowed}`
        : undefined,
  });
}

export const providerSchema = z.enum(["aws"]).describe("Cloud provider every resolution targets.");
export type Provider = z.infer<typeof providerSchema>;

export const intentKindSchema = z
  .enum(["http-api", "relational-database", "queue", "background-worker"])
  .describe("The architectural need this intent declares.");
export type IntentKind = z.infer<typeof intentKindSchema>;

// Roles are defined per intent kind by the catalog, not globally, so the model
// only requires a name and the vocabulary check decides what the target accepts.
export const roleSchema = z
  .string()
  .min(1)
  .describe("How the tier uses the linked intent. Valid roles depend on the target intent's kind.");
export type Role = z.infer<typeof roleSchema>;

export const usageProfileSchema = strictObject({
  requestsPerMonth: z
    .number()
    .int()
    .nonnegative()
    .describe("Expected HTTP requests per month across the application."),
  storageGb: z.number().nonnegative().describe("Expected data stored, in gigabytes."),
  // Optional so a milestone 1 blueprint loads unchanged; readers treat an
  // absent value as zero.
  messagesPerMonth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Expected messages sent to queues per month across the application; zero when absent."),
}).describe("Usage profile: the expected load every estimate and recommendation is relative to.");
export type UsageProfile = z.infer<typeof usageProfileSchema>;

const linkSchema = strictObject({
  to: intentName.describe("Name of the intent this tier is linked to."),
  role: roleSchema,
}).describe("A directional link from this tier to an intent, carrying a role.");
export type Link = z.infer<typeof linkSchema>;

const resolution = z
  .string()
  .min(1)
  .describe("The concrete kind of cloud resources chosen for this intent on the provider.");

// A tier (CONTEXT.md) runs the application's own code: it has an entry and
// may link to intents. The two other kinds carry neither.
function tierSchema<K extends string>(kind: K) {
  return strictObject({
    kind: z.literal(kind),
    resolution,
    entry: z
      .string({ error: (issue) => (issue.input === undefined ? `entry is required for ${kind === "http-api" ? "an" : "a"} ${kind} intent` : undefined) })
      .min(1)
      .describe("Path of the tier's entry module, relative to the blueprint."),
    links: z.array(linkSchema).optional(),
  });
}

const httpApiSchema = tierSchema("http-api");
const backgroundWorkerSchema = tierSchema("background-worker");

const relationalDatabaseSchema = strictObject({
  kind: z.literal("relational-database"),
  resolution,
});

const queueSchema = strictObject({
  kind: z.literal("queue"),
  resolution,
});

export const intentSchema = z
  .discriminatedUnion("kind", [httpApiSchema, relationalDatabaseSchema, queueSchema, backgroundWorkerSchema])
  .describe("An intent: an architectural need, with the resolution chosen for it.");
export type Intent = z.infer<typeof intentSchema>;

// The intents that are tiers, narrowed so callers reach entry and links.
export type Tier = Extract<Intent, { entry: string }>;
export const tierKinds: readonly IntentKind[] = ["http-api", "background-worker"];
export function isTier(intent: Intent): intent is Tier {
  return tierKinds.includes(intent.kind);
}

// What a sizing parameter holds: an instance class name, a memory size, a
// multi-AZ flag. Overrides pin values of the same shape.
const sizingValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type SizingValue = z.infer<typeof sizingValueSchema>;

export const environmentSchema = strictObject({
  usage: usageProfileSchema
    .partial()
    .optional()
    .describe("Usage profile values that replace the blueprint's for this environment."),
  policies: strictObject({}).optional().describe("Blueprint-wide policies. None exist in v0."),
  overrides: z
    .record(intentName, z.record(z.string(), sizingValueSchema))
    .optional()
    .describe("Per-intent pins of sizing parameters, replacing the derived value."),
}).describe(
  "An environment: a deployed instance of the blueprint. It may change usage, policies and overrides, never kinds or resolutions.",
);
export type Environment = z.infer<typeof environmentSchema>;

export const blueprintSchema = strictObject({
  name: z.string().min(1).describe("Application name."),
  provider: providerSchema,
  region: z.string().min(1).describe("Provider region every environment deploys to."),
  usage: usageProfileSchema,
  intents: z.record(intentName, intentSchema).describe("The intents of the application, by name."),
  environments: z
    .record(z.string().min(1), environmentSchema)
    .describe("The environments of the application, by name."),
}).meta({ title: "Hull blueprint (v0)", description: "Declares an application's architecture as intents." });
export type Blueprint = z.infer<typeof blueprintSchema>;
