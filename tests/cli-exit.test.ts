import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The `hull` binary itself, run on its source: a failing command prints its
// message on one line, and only that, and exits non-zero.

const root = fileURLToPath(new URL("..", import.meta.url));

function hull(args: string[], cwd: string) {
  return spawnSync(join(root, "node_modules", ".bin", "tsx"), ["--conditions=@hull/source", join(root, "packages", "cli", "src", "bin.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("the hull binary", () => {
  it("exits 1 with the message alone when a command fails", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "hull-bin-")));

    const result = hull(["init"], directory);
    expect(result.status).toBe(0);
    const failed = hull(["init"], directory);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe(`hull.yaml already exists in ${directory}; remove it first to start over\n`);
  }, 30000);

  it("names a missing argument and exits 1", () => {
    const failed = hull(["deploy"], realpathSync(mkdtempSync(join(tmpdir(), "hull-bin-"))));

    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe("Missing required argument: --env\n");
  }, 30000);

  it("prints the usage and exits 0 on --help", () => {
    const result = hull(["deploy", "--help"], realpathSync(mkdtempSync(join(tmpdir(), "hull-bin-"))));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--env");
    expect(result.stderr).toBe("");
  }, 30000);
});
