import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";
import { awsAccount } from "../deploy/aws-account.js";
import { loadEnvironment, readLocalState, stackTarget } from "../deploy/environment.js";
import { renderProgress } from "../deploy/progress.js";
import { pulumiEngine } from "../deploy/pulumi-engine.js";
import { passphraseFileName, stateFileName } from "../deploy/state.js";

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
      // Same pre-flight as deploy, minus the entry files: the code is
      // removed with the environment. The state file names the bucket, so
      // the account is only asked who it is.
      await engine.check();
      const environment = loadEnvironment(cwd, args.env);
      const local = readLocalState(cwd);
      if (local.recorded === undefined) {
        throw new Error(`nothing to destroy: no ${stateFileName} in ${cwd}, so nothing was deployed from here`);
      }
      const { recorded, passphrase } = local;
      const { blueprint } = environment;

      const { account, profile } = await provider.identity(blueprint.region);
      output(`Destroying ${blueprint.name} ${args.env} in ${blueprint.region} (account ${account}, profile ${profile}).`);

      const target = stackTarget(environment, recorded.stateBucket, passphrase);
      await engine.destroy(target, (event) => output(renderProgress(event)));
      await engine.removeStack(target);
      output(
        `Removed ${args.env} from the state bucket ${recorded.stateBucket}; the bucket, ${stateFileName} and ${passphraseFileName} are kept, so the next deploy starts from scratch.`,
      );
    },
  });
}
