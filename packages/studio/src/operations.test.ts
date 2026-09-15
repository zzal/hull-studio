import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioServer, startStudio, type ErrorResponse, type RunningStudio } from "./index.js";
import { createOperations, type Operation, type OperationMessage, type Operator, type ProgressEvent } from "./operations.js";
import { blueprintDirectory, sampleBlueprint } from "./testing.js";

// Plan, deploy and destroy from the dashboard: the studio runs them through
// an operator handed in by whoever starts it (the CLI builds one from its
// own commands; here a fake plays back synthetic events), one at a time,
// with the progress and the outcome broadcast over the WebSocket the
// dashboard already listens on. Edits are refused while one runs.

const deployEvents: ProgressEvent[] = [
  { phase: "note", message: "Deploying todos to dev in us-east-1 (account 123456789012, profile sandbox)." },
  { phase: "started", operation: "create", type: "aws:rds/instance:Instance", name: "db" },
  { phase: "done", operation: "create", type: "aws:rds/instance:Instance", name: "db" },
  { phase: "summary", changes: { create: 1 }, durationSeconds: 300 },
];

type FakeOptions = { fails?: string; hold?: Promise<void> };

// An operator that records what it is asked, plays the events back, and
// answers a fixed outcome; `hold` keeps an operation running until released.
function fakeOperator({ fails, hold }: FakeOptions = {}) {
  const calls: { kind: string; environment: string }[] = [];
  const run = async (kind: string, environment: string, onProgress: (event: ProgressEvent) => void) => {
    calls.push({ kind, environment });
    for (const event of deployEvents) onProgress(event);
    await hold;
    if (fails) throw new Error(fails);
  };
  const operator: Operator = {
    plan: async (environment, onProgress) => {
      await run("plan", environment, onProgress);
      return { changes: { create: 1 }, estimate: { expected: 14.58, low: 14.46, high: 15.12, withFreeTier: 14.48, label: "always-free allowances only" } };
    },
    deploy: async (environment, onProgress) => {
      await run("deploy", environment, onProgress);
      return { apiUrl: "https://abc.execute-api.us-east-1.amazonaws.com" };
    },
    destroy: (environment, onProgress) => run("destroy", environment, onProgress),
  };
  return { calls, operator };
}

function release() {
  let resolve!: () => void;
  const hold = new Promise<void>((done) => (resolve = done));
  return { hold, resolve };
}

async function start(app: ReturnType<typeof createStudioServer>, body: unknown) {
  const response = await app.request("/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Operation & ErrorResponse };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("POST /operations and GET /operations/current", () => {
  it("starts a deploy with 202, then reports it succeeded with its outcome", async () => {
    const { calls, operator } = fakeOperator();
    const operations = createOperations(operator);
    const app = createStudioServer({ directory: blueprintDirectory(sampleBlueprint), operations });

    const { status, body } = await start(app, { kind: "deploy", environment: "dev" });

    expect(status).toBe(202);
    expect(body).toMatchObject({ id: 1, kind: "deploy", environment: "dev", status: "running" });
    await settled();
    expect(calls).toEqual([{ kind: "deploy", environment: "dev" }]);
    const current = (await (await app.request("/operations/current")).json()) as Operation;
    expect(current).toMatchObject({ id: 1, kind: "deploy", environment: "dev", status: "succeeded", events: deployEvents, outcome: { apiUrl: "https://abc.execute-api.us-east-1.amazonaws.com" } });
  });

  it("refuses a second operation and a patch with 409 while one runs, and accepts both once it ends", async () => {
    const { hold, resolve } = release();
    const operations = createOperations(fakeOperator({ hold }).operator);
    const directory = blueprintDirectory(sampleBlueprint);
    const app = createStudioServer({ directory, operations });
    await start(app, { kind: "plan", environment: "dev" });

    const second = await start(app, { kind: "destroy", environment: "dev" });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "a plan of dev is running; wait for it to end" });
    const patch = await app.request("/blueprint", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify([{ op: "set", path: ["usage", "storageGb"], value: 2 }]) });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toEqual({ error: "a plan of dev is running; the blueprint cannot change until it ends" });
    expect(readFileSync(join(directory, "hull.yaml"), "utf8")).toBe(sampleBlueprint);

    resolve();
    await settled();
    expect((await start(app, { kind: "destroy", environment: "dev" })).status).toBe(202);
  });

  it("keeps the operator's failure message verbatim", async () => {
    const operations = createOperations(fakeOperator({ fails: "deploy of todos dev failed:\n  aws:rds/instance:Instance db: InsufficientDBInstanceCapacity\nRun `hull deploy --env dev` again to retry." }).operator);
    const app = createStudioServer({ directory: blueprintDirectory(sampleBlueprint), operations });

    await start(app, { kind: "deploy", environment: "dev" });
    await settled();

    const current = (await (await app.request("/operations/current")).json()) as Operation;
    expect(current).toMatchObject({
      status: "failed",
      error: "deploy of todos dev failed:\n  aws:rds/instance:Instance db: InsufficientDBInstanceCapacity\nRun `hull deploy --env dev` again to retry.",
    });
  });

  it("refuses an unknown kind, an environment the blueprint does not declare, and answers null when nothing ran", async () => {
    const app = createStudioServer({ directory: blueprintDirectory(sampleBlueprint), operations: createOperations(fakeOperator().operator) });

    expect(await start(app, { kind: "reboot", environment: "dev" })).toMatchObject({ status: 400, body: { error: '"reboot" is not an operation; operations are plan, deploy, destroy' } });
    expect(await start(app, { kind: "plan", environment: "staging" })).toMatchObject({ status: 404, body: { error: 'no environment "staging" in hull.yaml; environments are dev, prod' } });
    const current = await app.request("/operations/current");
    expect(current.status).toBe(200);
    expect(await current.json()).toBeNull();
  });

  it("answers 503 when the studio was started without an operator", async () => {
    const app = createStudioServer({ directory: blueprintDirectory(sampleBlueprint) });

    const { status, body } = await start(app, { kind: "plan", environment: "dev" });

    expect(status).toBe(503);
    expect(body).toEqual({ error: "this studio cannot run operations; start it with `hull studio`" });
  });
});

const running: RunningStudio[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((studio) => studio.close()));
});

// Every message on a fresh /changes connection, collected until the count
// is reached or a second passes.
async function collect(url: string, count: number): Promise<{ messages: OperationMessage[]; close: () => void }> {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/changes`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect to /changes")), { once: true });
  });
  const messages: OperationMessage[] = [];
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000);
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as OperationMessage);
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { messages: await done.then(() => messages), close: () => socket.close() };
}

describe("operations over the running studio", () => {
  it("streams the progress events and the outcome over the WebSocket, in order", async () => {
    const directory = blueprintDirectory(sampleBlueprint);
    const studio = await startStudio({ directory, operator: fakeOperator().operator });
    running.push(studio);
    const collecting = collect(studio.url, deployEvents.length + 2);

    const response = await fetch(`${studio.url}/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "deploy", environment: "dev" }) });

    expect(response.status).toBe(202);
    const { messages, close } = await collecting;
    expect(messages.map((message) => message.event)).toEqual(["operation", "operation", "operation", "operation", "operation", "operation"]);
    expect(messages[0]).toMatchObject({ operation: { id: 1, kind: "deploy", environment: "dev", status: "running" } });
    expect(messages.slice(1, 5).map((message) => (message.event === "operation" ? message.progress : undefined))).toEqual(deployEvents);
    expect(messages[5]).toMatchObject({ operation: { id: 1, status: "succeeded", outcome: { apiUrl: "https://abc.execute-api.us-east-1.amazonaws.com" } } });
    close();
  });

  it("defers the file watcher's changed signal to the end of the operation", async () => {
    const { hold, resolve } = release();
    const directory = blueprintDirectory(sampleBlueprint);
    const studio = await startStudio({ directory, operator: fakeOperator({ hold }).operator });
    running.push(studio);
    const collecting = collect(studio.url, deployEvents.length + 3);
    await fetch(`${studio.url}/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "deploy", environment: "dev" }) });
    await settled();

    // An editor writes the file mid-operation.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(directory, "hull.yaml"), sampleBlueprint.replace("storageGb: 1", "storageGb: 2"));
    await new Promise((done) => setTimeout(done, 200));
    resolve();

    const { messages, close } = await collecting;
    const events = messages.map((message) => message.event);
    expect(events.slice(0, 5)).toEqual(["operation", "operation", "operation", "operation", "operation"]);
    expect(events.slice(5)).toEqual(["operation", "changed"]);
    close();
  });
});
