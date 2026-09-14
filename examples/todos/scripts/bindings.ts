// Regenerates .hull/bindings from hull.yaml, what `hull deploy` and every
// studio save do. Here so the example typechecks against its binding without
// deploying: `pnpm bindings`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blueprintFileName, loadBlueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { writeBindings } from "@hull/compiler/bindings";

const directory = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { blueprint, diagnostics } = loadBlueprint(readFileSync(join(directory, blueprintFileName), "utf8"), vocabulary);
if (!blueprint) {
  console.error(`${blueprintFileName} is not valid:`);
  for (const { path, message } of diagnostics) console.error(`  ${path.join(".")}: ${message}`);
  process.exit(1);
}
for (const written of writeBindings(directory, blueprint)) console.log(`wrote ${written}`);
