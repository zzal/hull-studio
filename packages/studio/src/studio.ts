import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { blueprintFileName } from "@hull/blueprint";
import { watch } from "chokidar";
import { WebSocketServer } from "ws";
import { createOperations, type OperationMessage, type Operator } from "./operations.js";
import { createStudioServer, type StudioOptions } from "./server.js";

export type StartStudioOptions = Omit<StudioOptions, "operations"> & {
  // 0, the default, picks a free port.
  port?: number;
  // Plan, deploy and destroy; without it the dashboard cannot run them.
  operator?: Operator;
};

export type RunningStudio = {
  url: string;
  close: () => Promise<void>;
};

// The studio binds to the loopback address only: nothing on the network can
// reach a developer's blueprint.
const host = "127.0.0.1";

// The WebSocket path the dashboard listens on for the "changed" signal.
const changesPath = "/changes";

// An editor's save can show as two file events in a row; one signal within
// this window covers both.
const coalesceMs = 50;

// The built dashboard, one level under the package root whether this module
// runs from src/ or dist/.
const clientDirectory = fileURLToPath(new URL("../dist/client/", import.meta.url));

// Start the studio over one blueprint directory: the HTTP API, the dashboard
// as static files, and a WebSocket that pushes `{ event: "changed" }` whenever
// hull.yaml changes on disk, whether an editor or the studio itself wrote it,
// and every operation's progress.
export async function startStudio({ directory, onWrite, port = 0, operator }: StartStudioOptions): Promise<RunningStudio> {
  const operations = createOperations(operator);
  const app = createStudioServer({ directory, onWrite, operations });
  if (existsSync(clientDirectory)) {
    app.use("/*", serveStatic({ root: clientDirectory }));
  } else {
    app.get("/", (c) => c.text("The dashboard is not built; run `pnpm build` in packages/studio.", 503));
  }

  // Plain HTTP on the loopback address; the adapter's type also covers the
  // HTTPS and HTTP/2 servers it can create, which the WebSocket server does not take.
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(started as HttpServer));
    started.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`port ${port} is already in use`) : error);
    });
  });
  const { port: boundPort } = server.address() as AddressInfo;

  const sockets = new WebSocketServer({ server, path: changesPath });
  const send = (message: OperationMessage) => {
    const text = JSON.stringify(message);
    for (const socket of sockets.clients) if (socket.readyState === socket.OPEN) socket.send(text);
  };
  // The file signal is deferred while an operation runs: the dashboard
  // must not reload a file the operation is not deploying.
  let pending: NodeJS.Timeout | undefined;
  let deferred = false;
  const broadcast = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (operations.running()) deferred = true;
      else send({ event: "changed" });
    }, coalesceMs);
  };
  const unsubscribe = operations.subscribe((message) => {
    send(message);
    if (message.event === "operation" && message.operation.status !== "running" && deferred) {
      deferred = false;
      send({ event: "changed" });
    }
  });
  // Change, add and unlink: an editor's atomic save shows as a change, a
  // delete and recreate as the other two; the dashboard refetches on any.
  const watcher = watch(join(directory, blueprintFileName), { ignoreInitial: true });
  watcher.on("change", broadcast).on("add", broadcast).on("unlink", broadcast);

  return {
    url: `http://${host}:${boundPort}`,
    close: async () => {
      clearTimeout(pending);
      unsubscribe();
      await watcher.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
