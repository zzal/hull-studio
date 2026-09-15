import { writeBindings } from "@hull/compiler/bindings";
import { startStudio, type Operator } from "@hull/studio";
import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import { runDeploy, runDestroy, runPlan } from "../deploy/operations.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";

export function studioCommand({ cwd, output, openBrowser, signal, engine = pulumiEngine(), provider = awsAccount() }: CommandContext) {
  // The dashboard's plan, deploy and destroy, from the same functions the
  // commands use, against the same engine and account. The dashboard asks
  // its own confirmation before starting a deploy.
  const operator: Operator = {
    plan: (environment, onProgress) => runPlan({ cwd, engine, provider, onProgress }, environment),
    deploy: (environment, onProgress) => runDeploy({ cwd, engine, provider, onProgress }, environment, async () => true),
    destroy: (environment, onProgress) => runDestroy({ cwd, engine, provider, onProgress }, environment),
  };

  return defineCommand({
    meta: {
      name: "studio",
      description: "Open the dashboard for the blueprint in this directory, or a start screen when there is none",
    },
    args: {
      port: {
        type: "string",
        description: "Port to listen on; a free one by default",
      },
    },
    async run({ args }) {
      const port = args.port === undefined ? 0 : Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`"${args.port}" is not a port number`);
      }

      // Every studio save regenerates the bindings, so the tier's typed
      // access to its linked intents always matches the file.
      const studio = await startStudio({ directory: cwd, port, onWrite: (blueprint) => writeBindings(cwd, blueprint), operator });
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
