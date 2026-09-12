import { z } from "zod";
import { blueprintSchema } from "./model.js";

// The committed v0 schema, shipped inside this package so that until it is
// published at a public URL, `hull init` can point the IDE at the installed
// file. Resolves from both `src/` and `dist/`.
export const blueprintSchemaUrl = new URL("../schema/v0/hull.json", import.meta.url);

// Draft 7 is the dialect both JetBrains and the YAML language server handle best.
export function blueprintJsonSchema() {
  return z.toJSONSchema(blueprintSchema, { target: "draft-7", io: "input" });
}
