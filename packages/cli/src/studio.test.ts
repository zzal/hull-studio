import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterEach, describe, expect, it } from "vitest";
import { createHull } from "./index.js";

// Seam 2 from the milestone 1 spec: `hull studio` run in a temporary
// directory, checked by what it prints, the URL it opens the browser on, and
// what that URL serves. The browser opener is injected; the command runs
// until the context's signal aborts.

const sampleBlueprint = `name: todos
provider: aws
region: us-east-1
usage:
  requestsPerMonth: 100000
  storageGb: 1
intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
  db:
    kind: relational-database
    resolution: rds-postgres
environments:
  dev: {}
`;

// The command under test runs until its signal aborts; each test starts one
// and the teardown stops it.
let current: { stop: AbortController; done: Promise<unknown> } | undefined;
afterEach(async () => {
  current?.stop.abort();
  await current?.done.catch(() => undefined);
  current = undefined;
});

function directoryWithSample() {
  const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
  writeFileSync(join(directory, "hull.yaml"), sampleBlueprint);
  return directory;
}

type Options = { args?: string[]; openBrowser?: (url: string) => Promise<void> };

function runStudio(directory: string, { args = [], openBrowser }: Options = {}) {
  const lines: string[] = [];
  const stop = new AbortController();
  let browserOpened: (url: string) => void = () => undefined;
  const opened = new Promise<string>((resolve) => (browserOpened = resolve));
  const done = runCommand(
    createHull({
      cwd: directory,
      output: (line) => lines.push(line),
      openBrowser: async (url) => {
        browserOpened(url);
        await openBrowser?.(url);
      },
      signal: stop.signal,
    }),
    { rawArgs: ["studio", ...args] },
  );
  current = { stop, done };
  // The URL the browser was opened on, or the command's failure.
  const url = Promise.race([
    opened,
    done.then(() => {
      throw new Error("the command ended without opening a browser");
    }),
  ]);
  // A test that only awaits `done` still leaves this rejection handled.
  url.catch(() => undefined);
  return { lines, url, stop, done };
}

describe("hull studio", () => {
  it("prints the URL, opens the browser on it, and serves the dashboard API there on localhost", async () => {
    const { lines, url } = runStudio(directoryWithSample());

    const opened = await url;
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(lines).toEqual([`Studio at ${opened}`, "Press Ctrl+C to stop."]);
    const response = await fetch(`${opened}/blueprint`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { blueprint: { name: string } }).blueprint.name).toBe("todos");
  });

  // A patch through the studio API regenerates the binding module: here the
  // patch links the API to the database, so the module gains `db`.
  it("regenerates the bindings after a patch through the studio API", async () => {
    const directory = directoryWithSample();
    const { url } = runStudio(directory);
    const opened = await url;

    const response = await fetch(`${opened}/blueprint`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ op: "set", path: ["intents", "api", "links"], value: [{ to: "db", role: "read-write" }] }]),
    });

    expect(response.status).toBe(200);
    const bindings = readFileSync(join(directory, ".hull", "bindings", "index.ts"), "utf8");
    expect(bindings.split("\n")[0]).toMatch(/generated.*do not edit/i);
    expect(bindings).toContain("export const db");
    expect(bindings).toContain("connectionString()");
  });

  it("runs until the context's signal aborts, then stops serving", async () => {
    const { url, stop, done } = runStudio(directoryWithSample());
    const opened = await url;

    stop.abort();
    await done;

    await expect(fetch(`${opened}/blueprint`)).rejects.toThrow();
  });

  it("binds to the port asked for", async () => {
    const { url } = runStudio(directoryWithSample(), { args: ["--port", "4877"] });

    await expect(url).resolves.toBe("http://127.0.0.1:4877");
  });

  it("refuses a port that is not a number", async () => {
    await expect(runStudio(directoryWithSample(), { args: ["--port", "eighty"] }).done).rejects.toThrow(
      '"eighty" is not a port number',
    );
  });

  it("stops serving when the browser cannot be opened", async () => {
    const { url, done } = runStudio(directoryWithSample(), {
      openBrowser: async () => {
        throw new Error("no browser on this machine");
      },
    });
    const opened = await url;

    await expect(done).rejects.toThrow("no browser on this machine");
    await expect(fetch(`${opened}/blueprint`)).rejects.toThrow();
  });

  // The start screen: the studio starts without a blueprint and the
  // dashboard creates one through the server.
  it("starts without a blueprint, and serves the create route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hull-studio-"));
    const { url } = runStudio(directory);
    const opened = await url;

    expect((await fetch(`${opened}/blueprint`)).status).toBe(404);
    const created = await fetch(`${opened}/blueprint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "api-database" }),
    });

    expect(created.status).toBe(201);
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toContain("name: todos");
    expect(readFileSync(join(directory, ".hull", "bindings", "index.ts"), "utf8")).toContain("export const db");
  });
});
