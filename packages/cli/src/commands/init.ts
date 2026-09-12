import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blueprintSchemaUrl, sampleBlueprint } from "@hull/blueprint";
import { blueprintFileName } from "@hull/studio";
import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";

// Files under .hull that must never reach the repository: the generated
// bindings and the deploy secrets passphrase. The deploy state file, also under
// .hull, is committed on purpose so a second machine finds the same state.
const ignoredEntries = [".hull/bindings/", ".hull/passphrase"];
const ignoreHeader = "# Hull: generated bindings and the deploy secrets passphrase";

export function initCommand({ cwd, output }: CommandContext) {
  return defineCommand({
    meta: {
      name: "init",
      description: "Write a starting hull.yaml: an HTTP API linked to a relational database",
    },
    run() {
      const blueprintPath = join(cwd, blueprintFileName);
      if (existsSync(blueprintPath)) {
        throw new Error(`${blueprintFileName} already exists in ${cwd}; remove it first to start over`);
      }

      writeFileSync(blueprintPath, sampleBlueprint(blueprintSchemaUrl.href));
      output(
        `Wrote ${blueprintFileName}: an HTTP API on lambda-api-gateway linked read-write to a relational database on rds-postgres.`,
      );

      if (addIgnoreEntries(join(cwd, ".gitignore"))) {
        output(`Added ${ignoredEntries.join(" and ")} to .gitignore.`);
      }

      output("Next: run `hull studio` to see the estimate and the recommendation.");
    },
  });
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
