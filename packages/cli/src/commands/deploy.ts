import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import { runDeploy } from "../deploy/operations.js";
import { renderProgress } from "../deploy/progress.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";

export function deployCommand({ cwd, output, confirm, engine = pulumiEngine(), provider = awsAccount() }: CommandContext) {
  return defineCommand({
    meta: {
      name: "deploy",
      description: "Deploy the blueprint to an environment in your own AWS account, after showing the plan and asking",
    },
    args: {
      env: {
        type: "string",
        description: "The environment to deploy, as named in hull.yaml",
        required: true,
      },
      yes: {
        type: "boolean",
        description: "Deploy without asking, for scripts",
        default: false,
      },
    },
    async run({ args }) {
      // Refused before any cloud call: a deploy is never a surprise, so a
      // run that cannot ask must say so up front.
      const answer = args.yes ? async () => true : confirm;
      if (!answer) throw new Error("hull deploy needs a terminal to confirm the plan; pass --yes to deploy without the question");
      await runDeploy({ cwd, engine, provider, onProgress: (event) => output(renderProgress(event)) }, args.env, answer);
    },
  });
}
