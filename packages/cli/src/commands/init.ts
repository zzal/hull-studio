import { blueprintFileName } from "@hull/blueprint";
import { createBlueprint, isTemplateName, notATemplate, templateNames, templates } from "@hull/studio";
import { defineCommand } from "citty";
import type { CommandContext } from "../context.js";

// The scripted path to a first blueprint; the start screen of `hull studio`
// writes the same templates through the studio server.
export function initCommand({ cwd, output }: CommandContext) {
  return defineCommand({
    meta: {
      name: "init",
      description: "Write a starting hull.yaml from a template",
    },
    args: {
      template: {
        type: "string",
        description: `The template to write: ${templateNames.join(", ")}`,
        default: "api-database",
      },
    },
    run({ args }) {
      if (!isTemplateName(args.template)) throw new Error(notATemplate(args.template));
      const { ignoreAdded } = createBlueprint(cwd, args.template);
      output(`Wrote ${blueprintFileName}: ${templates.find((template) => template.name === args.template)!.description}.`);
      if (ignoreAdded) output(`Added .hull/bindings/ and .hull/passphrase to .gitignore.`);
      output("Next: run `hull studio` to see the estimate and the recommendation.");
    },
  });
}
