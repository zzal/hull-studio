import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blueprintFileName, loadBlueprint } from "@hull/blueprint";
import { vocabulary } from "@hull/catalog";
import { Hono } from "hono";

export type StudioOptions = {
  // Directory holding hull.yaml.
  directory: string;
};

// The studio HTTP API over one blueprint directory. Server only; the
// dashboard client lands with the dashboard ticket.
export function createStudioServer({ directory }: StudioOptions) {
  const app = new Hono();

  app.get("/blueprint", (c) => {
    const file = join(directory, blueprintFileName);
    if (!existsSync(file)) return c.json({ error: `no ${blueprintFileName} in ${directory}` }, 404);
    return c.json(loadBlueprint(readFileSync(file, "utf8"), vocabulary));
  });

  return app;
}
