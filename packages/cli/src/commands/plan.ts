import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import { runPlan } from "../deploy/operations.js";
import { renderProgress } from "../deploy/progress.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";

export function planCommand({ cwd, output, engine = pulumiEngine(), provider = awsAccount() }: CommandContext) {
  return defineCommand({
    meta: {
      name: "plan",
      description: "Show what deploying an environment would create, and its monthly figure, without creating anything",
    },
    args: {
      env: {
        type: "string",
        description: "The environment to plan, as named in hull.yaml",
        required: true,
      },
    },
    async run({ args }) {
      await runPlan({ cwd, engine, provider, onProgress: (event) => output(renderProgress(event)) }, args.env);
    },
  });
}
