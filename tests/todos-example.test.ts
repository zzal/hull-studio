import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blueprintFileName, isTier, loadBlueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { bundleEntry, writeBindings } from "@hull/compiler";
import { beforeAll, describe, expect, it } from "vitest";

// The todos example against its generated bindings: the bindings are written
// from its blueprint, then each tier's entry is bundled as a deploy would and
// the example is typechecked. What `hull deploy` will do, minus AWS.

const root = fileURLToPath(new URL("..", import.meta.url));
const example = join(root, "examples", "todos");

describe("the todos example", () => {
  let entries: Record<string, string>;

  beforeAll(() => {
    const loaded = loadBlueprint(readFileSync(join(example, blueprintFileName), "utf8"), vocabulary);
    expect(loaded.diagnostics).toEqual([]);
    entries = Object.fromEntries(
      Object.entries(loaded.blueprint!.intents).flatMap(([name, intent]) => (isTier(intent) ? [[name, intent.entry]] : [])),
    );
    expect(Object.keys(entries)).toEqual(["api", "worker"]);
    const [index] = writeBindings(example, loaded.blueprint!);
    const bindings = readFileSync(index!, "utf8");
    expect(bindings).toContain("export const db: DatabaseBinding");
    expect(bindings).toContain('export const jobs: Pick<QueueBinding, "send" | "consume">');
  });

  it("bundles each tier's entry to one module exporting the Lambda handler", async () => {
    for (const [name, entry] of Object.entries(entries)) {
      const { code } = await bundleEntry({ directory: example, entry });

      expect(code, name).toContain("export {");
      expect(code, name).toMatch(/\bhandler\b/);
    }
  }, 60000);

  it("typechecks against the generated binding", () => {
    const tsc = join(root, "node_modules", ".bin", "tsc");

    expect(() => execFileSync(tsc, ["--noEmit", "-p", join(example, "tsconfig.json")], { encoding: "utf8" })).not.toThrow();
  }, 60000);
});
