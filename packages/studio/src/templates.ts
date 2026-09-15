import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { blueprintFileName, blueprintSchemaUrl } from "@hull/blueprint";

// The blueprints a developer starts from, written by the start screen
// through POST /blueprint and by `hull init --template`. In the canonical
// form of the `yaml` Document API, so later studio edits on a Hull-created
// file never produce formatting noise. The two comment lines are what
// JetBrains and the YAML language server read to find the schema.

export const templateNames = ["api-database", "blank"] as const;
export type TemplateName = (typeof templateNames)[number];

export type Template = { name: TemplateName; description: string };

export const templates: readonly Template[] = [
  { name: "api-database", description: "an HTTP API on lambda-api-gateway linked read-write to a relational database on rds-postgres" },
  { name: "blank", description: "a blueprint named after this folder, on aws in us-east-1, with no intents and a dev environment" },
];

export function isTemplateName(name: unknown): name is TemplateName {
  return typeof name === "string" && (templateNames as readonly string[]).includes(name);
}

export const notATemplate = (name: string) => `"${name}" is not a template; templates are ${templateNames.join(", ")}`;

export type TemplateContext = { schemaUrl: string; applicationName: string };

const schemaLines = (schemaUrl: string) => `# $schema: ${schemaUrl}
# yaml-language-server: $schema=${schemaUrl}
`;

// The milestone 1 plan's sample: what `hull init` has always written.
const apiDatabase = (schemaUrl: string) => `${schemaLines(schemaUrl)}
name: todos
provider: aws
region: us-east-1

usage:
  # usage profile, low-end defaults from \`hull init\`
  requestsPerMonth: 100000
  storageGb: 1

intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
      - to: db
        role: read-write

  db:
    kind: relational-database
    resolution: rds-postgres

environments:
  dev: {}
  prod:
    usage:
      requestsPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
`;

// Nothing declared yet: the studio adds intents one at a time. The usage
// profile starts at the same low-end defaults.
const blank = (schemaUrl: string, applicationName: string) => `${schemaLines(schemaUrl)}
name: ${applicationName}
provider: aws
region: us-east-1

usage:
  requestsPerMonth: 100000
  storageGb: 1

intents: {}

environments:
  dev: {}
`;

export function renderTemplate(name: TemplateName, { schemaUrl, applicationName }: TemplateContext): string {
  return name === "blank" ? blank(schemaUrl, applicationName) : apiDatabase(schemaUrl);
}

// Files under .hull that must never reach the repository: the generated
// bindings and the deploy secrets passphrase. The deploy state file, also
// under .hull, is committed on purpose so a second machine finds the same
// state.
export const ignoredEntries = [".hull/bindings/", ".hull/passphrase"];
const ignoreHeader = "# Hull: generated bindings and the deploy secrets passphrase";

// The blueprint file already exists: the one reason a template is refused.
export class BlueprintExistsError extends Error {
  override readonly name = "BlueprintExistsError";
}

// Writes the template as hull.yaml in the directory, with the .gitignore
// entries; returns what was written and whether .gitignore gained anything.
export function createBlueprint(directory: string, name: TemplateName): { text: string; ignoreAdded: boolean } {
  const path = join(directory, blueprintFileName);
  if (existsSync(path)) throw new BlueprintExistsError(`${blueprintFileName} already exists in ${directory}; remove it first to start over`);
  const text = renderTemplate(name, { schemaUrl: blueprintSchemaUrl.href, applicationName: applicationNameOf(directory) });
  writeFileSync(path, text);
  return { text, ignoreAdded: addIgnoreEntries(join(directory, ".gitignore")) };
}

// The folder's name; a root directory has none, so it gets a plain one.
function applicationNameOf(directory: string): string {
  return basename(directory) || "app";
}

// Returns whether anything was added.
function addIgnoreEntries(gitignorePath: string): boolean {
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split("\n").map((line) => line.trim());
  const missing = ignoredEntries.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;

  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(gitignorePath, `${existing}${separator}${ignoreHeader}\n${missing.join("\n")}\n`);
  return true;
}
