import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadResult } from "@hull/blueprint";
import { afterEach, describe, expect, it } from "vitest";
import { startStudio, type RunningStudio } from "./index.js";
import { blueprintDirectory, sampleBlueprint } from "./testing.js";

// The running studio: the HTTP API served on localhost on a free port, with a
// WebSocket at /changes that pushes a "changed" signal whenever hull.yaml
// changes on disk, whether an editor or the studio itself wrote it. The
// dashboard refetches on that signal; the React client itself is checked by
// hand.

const changedWithin = 1000;

const running: RunningStudio[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((studio) => studio.close()));
});

async function studioOverSample(port = 0) {
  const directory = blueprintDirectory(sampleBlueprint);
  const studio = await startStudio({ directory, port });
  running.push(studio);
  return { directory, file: join(directory, "hull.yaml"), studio };
}

// The next message on a fresh /changes connection, or a rejection after a
// second of silence.
async function connectToChanges(url: string) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/changes`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect to /changes")), { once: true });
  });
  const next = () =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no signal within ${changedWithin} ms`)), changedWithin);
      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)));
        },
        { once: true },
      );
    });
  return { next, close: () => socket.close() };
}

describe("startStudio", () => {
  it("serves the studio API on localhost on a free port", async () => {
    const { studio } = await studioOverSample();

    expect(studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${studio.url}/blueprint`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as LoadResult).blueprint?.name).toBe("todos");
  });

  it("refuses a port already in use", async () => {
    const { studio } = await studioOverSample();
    const port = Number(new URL(studio.url).port);

    await expect(startStudio({ directory: blueprintDirectory(sampleBlueprint), port })).rejects.toThrow(
      `port ${port} is already in use`,
    );
  });

  it("signals a change when an editor writes the blueprint", async () => {
    const { file, studio } = await studioOverSample();
    const changes = await connectToChanges(studio.url);

    writeFileSync(file, sampleBlueprint.replace("requestsPerMonth: 100000", "requestsPerMonth: 250000"));

    await expect(changes.next()).resolves.toEqual({ event: "changed" });
    changes.close();
  });

  it("signals a change after its own write through PUT /blueprint", async () => {
    const { studio } = await studioOverSample();
    const changes = await connectToChanges(studio.url);

    const response = await fetch(`${studio.url}/blueprint`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ op: "set", path: ["usage", "requestsPerMonth"], value: 250000 }]),
    });

    expect(response.status).toBe(200);
    await expect(changes.next()).resolves.toEqual({ event: "changed" });
    changes.close();
  });

  // What the dashboard's banner shows after a broken hand edit: the signal,
  // then the diagnostics from the blueprint route.
  it("signals a broken edit, which the blueprint route then reports as diagnostics", async () => {
    const { file, studio } = await studioOverSample();
    const changes = await connectToChanges(studio.url);

    writeFileSync(file, sampleBlueprint.replace("role: read-write", "role: admin"));

    await expect(changes.next()).resolves.toEqual({ event: "changed" });
    const loaded = (await (await fetch(`${studio.url}/blueprint`)).json()) as LoadResult;
    expect(loaded.blueprint).toBeNull();
    expect(loaded.diagnostics.map((d) => d.path)).toEqual([["intents", "api", "links", 0, "role"]]);
    changes.close();
  });
});
