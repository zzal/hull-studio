import { z } from "zod";
import { blueprintSchema } from "./model.js";

// Where the committed v0 schema lives, relative to this package. The
// `docs/schema` folder is the published artifact; until it is published at a
// public URL, `hull init` points the IDE at this file.
export const blueprintSchemaUrl = new URL("../../../docs/schema/v0/hull.json", import.meta.url);

// Draft 7 is the dialect both JetBrains and the YAML language server handle best.
export function blueprintJsonSchema() {
  return z.toJSONSchema(blueprintSchema, { target: "draft-7", io: "input" });
}
