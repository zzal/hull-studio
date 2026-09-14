import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleEntry, CompileError } from "./index.js";

// Seam: the entry of a tier bundled to the one file the Lambda runs. The
// bundle is checked by importing it, not by reading it.

function projectWith(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "hull-compiler-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  return directory;
}

// The bundle as the Lambda gets it: an index.mjs on its own, with nothing
// else to resolve against.
function importBundle(code: string) {
  const file = join(mkdtempSync(join(tmpdir(), "hull-bundle-")), "index.mjs");
  writeFileSync(file, code);
  return import(pathToFileURL(file).href) as Promise<Record<string, unknown>>;
}

describe("bundleEntry", () => {
  it("bundles an entry and what it imports into one module exporting the handler", async () => {
    const directory = projectWith({
      "src/api/index.ts": 'import { greeting } from "../greeting.js";\nexport const handler = async () => ({ statusCode: 200, body: greeting("hull") });\n',
      "src/greeting.ts": "export const greeting = (name: string): string => `hello ${name}`;\n",
    });

    const { code } = await bundleEntry({ directory, entry: "src/api/index.ts" });

    const bundle = await importBundle(code);
    expect(typeof bundle.handler).toBe("function");
    await expect((bundle.handler as () => Promise<unknown>)()).resolves.toEqual({ statusCode: 200, body: "hello hull" });
  });

  it("refuses an entry that does not export a handler", async () => {
    const directory = projectWith({ "src/api/index.ts": "export const intent = 'api';\n" });

    await expect(bundleEntry({ directory, entry: "src/api/index.ts" })).rejects.toThrow(
      new CompileError("src/api/index.ts must export a Lambda handler named handler"),
    );
  });

  it("refuses a missing entry", async () => {
    const directory = projectWith({});

    await expect(bundleEntry({ directory, entry: "src/api/index.ts" })).rejects.toThrow(
      new CompileError(`no entry src/api/index.ts in ${directory}`),
    );
  });
});
