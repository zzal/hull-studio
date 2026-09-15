import type { LoadResult, Op } from "@hull/blueprint";
import type {
  CatalogResponse,
  ErrorResponse,
  EstimateResponse,
  Operation,
  OperationKind,
  OperationMessage,
  RecommendationsResponse,
  Template,
} from "../../src/index.js";

export type { CatalogResponse, ErrorResponse, EstimateResponse, LoadResult, Operation, OperationKind, RecommendationsResponse, Template };

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
const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const withEnvironment = (path: string, environment: string) => `${path}?environment=${encodeURIComponent(environment)}`;

export const readBlueprint = () => getJson<LoadResult>("/blueprint");
export const readEstimate = (environment: string) => getJson<EstimateResponse>(withEnvironment("/estimate", environment));
export const readRecommendations = (environment: string) => getJson<RecommendationsResponse>(withEnvironment("/recommendations", environment));
export const readCatalog = (environment: string) => getJson<CatalogResponse>(withEnvironment("/catalog", environment));
export const readTemplates = () => getJson<Template[]>("/templates");
export const readCurrentOperation = () => getJson<Operation | null>("/operations/current");

// POST /blueprint with a template: the start screen's way of writing the
// first file.
export const createBlueprint = async (template: string) => parse<LoadResult>(await fetch("/blueprint", { method: "POST", ...json({ template }) }));

// POST /operations: starts a plan, a deploy or a destroy of the environment.
export const startOperation = async (kind: OperationKind, environment: string) =>
  parse<Operation>(await fetch("/operations", { method: "POST", ...json({ kind, environment }) }));

// PUT /blueprint with the operations; the studio writes the file only when
// the result is valid, and answers as GET /blueprint would afterwards. A
// refused edit rejects with the RouteError carrying the diagnostics.
export async function patchBlueprint(ops: Op[]): Promise<LoadResult> {
  return parse<LoadResult>(await fetch("/blueprint", { method: "PUT", ...json(ops) }));
}

export type ChangeListeners = {
  // Every "changed" signal from the studio, and every reconnection, since
  // anything may have changed while disconnected.
  onChanged: () => void;
  // Every operation message: its start, each progress event, its end.
  onOperation: (message: Extract<OperationMessage, { event: "operation" }>) => void;
};

// Listens on the studio's WebSocket. Returns a function that stops listening.
export function listenForChanges({ onChanged, onOperation }: ChangeListeners): () => void {
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
      const message = JSON.parse(String(event.data)) as OperationMessage;
      if (message.event === "changed") onChanged();
      else if (message.event === "operation") onOperation(message);
    });
    socket.addEventListener("close", () => setTimeout(connect, 1000));
  };
  connect();
  return () => {
    stopped = true;
    socket?.close();
  };
}
