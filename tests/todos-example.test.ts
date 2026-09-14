import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blueprintFileName, loadBlueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { bundleEntry, writeBindings } from "@hull/compiler";
import { beforeAll, describe, expect, it } from "vitest";

// The todos example against its generated binding: the bindings are written
// from its blueprint, then the entry is bundled as a deploy would and the
// example is typechecked. What `hull deploy` will do, minus AWS.

const root = fileURLToPath(new URL("..", import.meta.url));
const example = join(root, "examples", "todos");

describe("the todos example", () => {
  let entry: string;

  beforeAll(() => {
    const loaded = loadBlueprint(readFileSync(join(example, blueprintFileName), "utf8"), vocabulary);
    expect(loaded.diagnostics).toEqual([]);
    const api = loaded.blueprint!.intents.api;
    if (api?.kind !== "http-api") throw new Error("the example's api intent is not an http-api");
    entry = api.entry;
    writeBindings(example, loaded.blueprint!);
  });

  it("bundles its entry to one module exporting the Lambda handler", async () => {
    const { code } = await bundleEntry({ directory: example, entry });

    expect(code).toContain("export {");
    expect(code).toMatch(/\bhandler\b/);
  }, 30000);

  it("typechecks against the generated binding", () => {
    const tsc = join(root, "node_modules", ".bin", "tsc");

    expect(() => execFileSync(tsc, ["--noEmit", "-p", join(example, "tsconfig.json")], { encoding: "utf8" })).not.toThrow();
  }, 60000);
});
