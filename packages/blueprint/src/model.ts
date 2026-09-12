import { z } from "zod";

// Blueprint v0: exactly what the milestone 1 proof of concept needs, in Hull's
// own vocabulary (CONTEXT.md). Resolution names are the only provider-specific
// values, by definition, and are validated against the catalog vocabulary at
// load time rather than enumerated here.

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be lower-case letters, digits or underscores, starting with a letter");

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
  .enum(["http-api", "relational-database"])
  .describe("The architectural need this intent declares.");
export type IntentKind = z.infer<typeof intentKindSchema>;

export const roleSchema = z
  .enum(["read-write"])
  .describe("How the tier uses the linked intent. Valid roles depend on the target intent's kind.");
export type Role = z.infer<typeof roleSchema>;

export const usageProfileSchema = strictObject({
  requestsPerMonth: z
    .number()
    .int()
    .nonnegative()
    .describe("Expected HTTP requests per month across the application."),
  storageGb: z.number().nonnegative().describe("Expected data stored, in gigabytes."),
}).describe("Usage profile: the expected load every estimate and recommendation is relative to.");
export type UsageProfile = z.infer<typeof usageProfileSchema>;

const linkSchema = strictObject({
  to: identifier.describe("Name of the intent this tier is linked to."),
  role: roleSchema,
}).describe("A directional link from this tier to an intent, carrying a role.");
export type Link = z.infer<typeof linkSchema>;

const resolution = z
  .string()
  .min(1)
  .describe("The concrete kind of cloud resources chosen for this intent on the provider.");

const httpApiSchema = strictObject({
  kind: z.literal("http-api"),
  resolution,
  entry: z.string().min(1).describe("Path of the tier's entry module, relative to the blueprint."),
  links: z.array(linkSchema).optional(),
});

const relationalDatabaseSchema = strictObject({
  kind: z.literal("relational-database"),
  resolution,
});

export const intentSchema = z
  .discriminatedUnion("kind", [httpApiSchema, relationalDatabaseSchema])
  .describe("An intent: an architectural need, with the resolution chosen for it.");
export type Intent = z.infer<typeof intentSchema>;

const overrideValue = z.union([z.string(), z.number(), z.boolean()]);

export const environmentSchema = strictObject({
  usage: usageProfileSchema
    .partial()
    .optional()
    .describe("Usage profile values that replace the blueprint's for this environment."),
  policies: strictObject({}).optional().describe("Blueprint-wide policies. None exist in v0."),
  overrides: z
    .record(identifier, z.record(z.string(), overrideValue))
    .optional()
    .describe("Per-intent pins of sizing parameters, replacing the derived value."),
}).describe(
  "An environment: a deployed instance of the blueprint. It may change usage, policies and overrides, never kinds or resolutions.",
);
export type Environment = z.infer<typeof environmentSchema>;

export const blueprintSchema = strictObject({
  name: identifier.describe("Application name."),
  provider: providerSchema,
  region: z.string().min(1).describe("Provider region every environment deploys to."),
  usage: usageProfileSchema,
  intents: z.record(identifier, intentSchema).describe("The intents of the application, by name."),
  environments: z
    .record(identifier, environmentSchema)
    .describe("The environments of the application, by name."),
}).meta({ title: "Hull blueprint (v0)", description: "Declares an application's architecture as intents." });
export type Blueprint = z.infer<typeof blueprintSchema>;
