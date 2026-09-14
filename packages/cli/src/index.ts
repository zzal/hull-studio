import { defineCommand } from "citty";
import { deployCommand } from "./commands/deploy.js";
import { initCommand } from "./commands/init.js";
import { studioCommand } from "./commands/studio.js";
import type { CommandContext } from "./context.js";

export type { CommandContext } from "./context.js";
export type { DeployEngine, ProgressEvent, ProviderAccount, StackTarget } from "./deploy/engine.js";

// The `hull` command tree. `destroy` lands with its ticket.
export function createHull(context: CommandContext) {
  return defineCommand({
    meta: {
      name: "hull",
      description: "Declare what your application needs; Hull picks, estimates and deploys the cloud resources",
    },
    subCommands: {
      init: initCommand(context),
      studio: studioCommand(context),
      deploy: deployCommand(context),
    },
  });
}
