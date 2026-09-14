import { existsSync } from "node:fs";
import { join } from "node:path";
import { blueprintFileName } from "@hull/blueprint";
import { writeBindings } from "@hull/compiler/bindings";
import { startStudio } from "@hull/studio";
import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";

export function studioCommand({ cwd, output, openBrowser, signal }: CommandContext) {
  return defineCommand({
    meta: {
      name: "studio",
      description: "Open the dashboard for the blueprint in this directory",
    },
    args: {
      port: {
        type: "string",
        description: "Port to listen on; a free one by default",
      },
    },
    async run({ args }) {
      if (!existsSync(join(cwd, blueprintFileName))) {
        throw new Error(`no ${blueprintFileName} in ${cwd}; run \`hull init\` first`);
      }
      const port = args.port === undefined ? 0 : Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`"${args.port}" is not a port number`);
      }

      // Every studio save regenerates the bindings, so the tier's typed
      // access to its linked intents always matches the file.
      const studio = await startStudio({ directory: cwd, port, onWrite: (blueprint) => writeBindings(cwd, blueprint) });
      try {
        output(`Studio at ${studio.url}`);
        output("Press Ctrl+C to stop.");
        await openBrowser(studio.url);
        // Runs until stopped: Ctrl+C ends the process, the context's signal
        // ends the command.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        await studio.close();
      }
    },
  });
}
