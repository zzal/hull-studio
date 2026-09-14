import type { LoadResult, Op } from "@hull/blueprint";
import type { ErrorResponse, EstimateResponse, RecommendationsResponse } from "../../src/index.js";

export type { ErrorResponse, EstimateResponse, LoadResult, RecommendationsResponse };

// The dashboard never reads the file; everything comes from the studio
// routes, on the same origin.

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly response: ErrorResponse,
  ) {
    super(response.error);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T | ErrorResponse;
  if (!response.ok) throw new RouteError(response.status, body as ErrorResponse);
  return body as T;
}

const getJson = async <T>(path: string) => parse<T>(await fetch(path));

export const readBlueprint = () => getJson<LoadResult>("/blueprint");
export const readEstimate = (environment: string) =>
  getJson<EstimateResponse>(`/estimate?environment=${encodeURIComponent(environment)}`);
export const readRecommendations = (environment: string) =>
  getJson<RecommendationsResponse>(`/recommendations?environment=${encodeURIComponent(environment)}`);

// Calls `onChanged` on every "changed" signal from the studio, and again on
// every reconnection, since anything may have changed while disconnected.
// Returns a function that stops listening.
export function listenForChanges(onChanged: () => void): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let reconnecting = false;
  const connect = () => {
    if (stopped) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/changes`);
    socket.addEventListener("open", () => {
      if (reconnecting) onChanged();
      reconnecting = true;
    });
    socket.addEventListener("message", (event) => {
      const signal = JSON.parse(String(event.data)) as { event: string };
      if (signal.event === "changed") onChanged();
    });
    socket.addEventListener("close", () => setTimeout(connect, 1000));
  };
  connect();
  return () => {
    stopped = true;
    socket?.close();
  };
}

// PUT /blueprint with the operations; the studio writes the file only when
// the result is valid, and answers as GET /blueprint would afterwards. A
// refused edit rejects with the RouteError carrying the diagnostics.
export async function patchBlueprint(ops: Op[]): Promise<LoadResult> {
  return parse<LoadResult>(
    await fetch("/blueprint", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ops) }),
  );
}
