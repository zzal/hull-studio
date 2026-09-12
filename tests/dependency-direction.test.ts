import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Dependency direction from docs/milestones/01-proof-of-concept.md:
//   cli -> studio, compiler -> catalog -> blueprint; studio -> catalog -> blueprint.
// Nothing points back. Each entry lists every workspace package a package may
// depend on, transitive reach included, so a direct edge to blueprint is fine.
const allowedWorkspaceDependencies: Record<string, readonly string[]> = {
  "@hull/blueprint": [],
  "@hull/catalog": ["@hull/blueprint"],
  "@hull/compiler": ["@hull/catalog", "@hull/blueprint"],
  "@hull/studio": ["@hull/catalog", "@hull/blueprint"],
  "@hull/cli": ["@hull/studio", "@hull/compiler", "@hull/blueprint"],
};

const packagesDir = join(import.meta.dirname, "..", "packages");

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifests(): Manifest[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8")) as Manifest,
    );
}

function workspaceDependencies(manifest: Manifest): string[] {
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
    name.startsWith("@hull/"),
  );
}

describe("workspace dependency direction", () => {
  const manifests = readManifests();

  it("has exactly the five packages from the plan", () => {
    expect(manifests.map((m) => m.name).sort()).toEqual(
      Object.keys(allowedWorkspaceDependencies).sort(),
    );
  });

  it.each(Object.entries(allowedWorkspaceDependencies))(
    "%s depends only on packages it may know about",
    (name, permitted) => {
      const manifest = manifests.find((m) => m.name === name);
      if (!manifest) throw new Error(`${name} has no manifest under packages/`);
      const forbidden = workspaceDependencies(manifest).filter((dep) => !permitted.includes(dep));
      expect(forbidden).toEqual([]);
    },
  );
});
