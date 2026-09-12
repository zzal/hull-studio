import { defineCommand } from "citty";
import { initCommand } from "./commands/init.js";
import type { CommandContext } from "./context.js";

export type { CommandContext } from "./context.js";

// The `hull` command tree. `studio`, `deploy` and `destroy` land with their tickets.
export function createHull(context: CommandContext) {
  return defineCommand({
    meta: {
      name: "hull",
      description: "Declare what your application needs; Hull picks, prices and deploys the cloud resources",
    },
    subCommands: {
      init: initCommand(context),
    },
  });
}
