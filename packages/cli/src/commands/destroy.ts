import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import { runDestroy } from "../deploy/operations.js";
import { renderProgress } from "../deploy/progress.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";

export function destroyCommand({ cwd, output, engine = pulumiEngine(), provider = awsAccount() }: CommandContext) {
  return defineCommand({
    meta: {
      name: "destroy",
      description: "Remove every resource of an environment from your AWS account; the state bucket stays",
    },
    args: {
      env: {
        type: "string",
        description: "The environment to destroy, as named in hull.yaml",
        required: true,
      },
    },
    async run({ args }) {
      await runDestroy({ cwd, engine, provider, onProgress: (event) => output(renderProgress(event)) }, args.env);
    },
  });
}
