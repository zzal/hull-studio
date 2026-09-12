import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBlueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { Hono } from "hono";

export type StudioOptions = {
  // Directory holding hull.yaml.
  directory: string;
};

export const blueprintFileName = "hull.yaml";

// The studio HTTP API over one blueprint directory. Server only; the
// dashboard client lands with the dashboard ticket.
export function createStudioApp({ directory }: StudioOptions) {
  const app = new Hono();

  app.get("/blueprint", (c) => {
    const file = join(directory, blueprintFileName);
    if (!existsSync(file)) return c.json({ error: `no ${blueprintFileName} in ${directory}` }, 404);
    return c.json(loadBlueprint(readFileSync(file, "utf8"), vocabulary));
  });

  return app;
}

export type StudioApp = ReturnType<typeof createStudioApp>;
