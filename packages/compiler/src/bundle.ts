import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { CompileError } from "./errors.js";

export type BundleOptions = {
  // The directory holding the blueprint; the entry is relative to it.
  directory: string;
  entry: string;
};

export type Bundle = { code: string };

// The Node runtime the Lambda runs; the bundle targets the same.
export const nodeRuntime = "nodejs22.x";
const esbuildTarget = "node22";

// CommonJS dependencies bundled into an ES module may call require; the
// shim gives them one.
const requireShim = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

// One ES module from the tier's entry and everything it imports, for the
// Lambda to run as index.mjs. The module must export `handler`, checked on
// the bundle's own exports.
export async function bundleEntry({ directory, entry }: BundleOptions): Promise<Bundle> {
  const entryPath = join(directory, entry);
  if (!existsSync(entryPath)) throw new CompileError(`no entry ${entry} in ${directory}`);

  const result = await build({
    entryPoints: [entryPath],
    absWorkingDir: directory,
    bundle: true,
    platform: "node",
    format: "esm",
    target: esbuildTarget,
    banner: { js: requireShim },
    write: false,
    metafile: true,
    outfile: "index.mjs",
    logLevel: "silent",
  });

  const [output] = Object.values(result.metafile.outputs);
  if (!output?.exports.includes("handler")) throw new CompileError(`${entry} must export a Lambda handler named handler`);
  return { code: result.outputFiles[0]!.text };
}
