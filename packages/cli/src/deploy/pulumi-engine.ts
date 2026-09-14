import type { EngineEvent, PulumiFn } from "@pulumi/pulumi/automation/index.js";
import { ambientProfile } from "./aws-account.js";
import type { DeployEngine, StackTarget } from "./engine.js";
import type { ProgressEvent } from "./progress.js";

// The deploy engine over Pulumi's Automation API, as the second spike
// settled it: LocalWorkspace with the inline program, the project backend
// pointed at the state bucket (which overrides any Pulumi Cloud login, so
// no login step exists), the passphrase secrets provider, the region set in
// both the process environment and the provider config, credentials from
// the ambient AWS profile. The SDK is loaded on first use so `hull init`
// and `hull studio` never pay for it.

const installHint = "if it is missing, install it with `brew install pulumi` (macOS) or `curl -fsSL https://get.pulumi.com | sh`, then run `hull deploy` again";

export function pulumiEngine(): DeployEngine {
  const automation = () => import("@pulumi/pulumi/automation/index.js");

  async function stackFor({ project, stack, region, backendUrl, passphrase }: StackTarget, program: PulumiFn) {
    const { LocalWorkspace } = await automation();
    const envVars: Record<string, string> = { PULUMI_CONFIG_PASSPHRASE: passphrase, AWS_REGION: region };
    const profile = ambientProfile();
    if (profile) envVars.AWS_PROFILE = profile;
    const selected = await LocalWorkspace.createOrSelectStack(
      { projectName: project, stackName: stack, program },
      {
        projectSettings: { name: project, runtime: "nodejs", backend: { url: backendUrl } },
        secretsProvider: "passphrase",
        envVars,
      },
    );
    await selected.setConfig("aws:region", { value: region });
    return selected;
  }

  return {
    async check() {
      const { PulumiCommand } = await automation();
      // A CLI slightly older than the SDK is accepted; a missing or far too
      // old one is not, and the SDK's own words say which.
      try {
        await PulumiCommand.get();
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`the Pulumi CLI is not usable (${cause}); ${installHint}`);
      }
    },
    async up(target, program, onProgress) {
      const stack = await stackFor(target, program);
      const result = await stack.up({ color: "never", onEvent: (event) => forward(event, onProgress) });
      return Object.fromEntries(Object.entries(result.outputs).map(([name, output]) => [name, output.value]));
    },
    async destroy(target, onProgress) {
      const stack = await stackFor(target, async () => ({}));
      await stack.destroy({ color: "never", onEvent: (event) => forward(event, onProgress) });
    },
    async removeStack(target) {
      const stack = await stackFor(target, async () => ({}));
      await stack.workspace.removeStack(target.stack);
    },
  };
}

function forward(event: EngineEvent, onProgress: (event: ProgressEvent) => void) {
  const progress = progressFromEngineEvent(event);
  if (progress) onProgress(progress);
}

// Resources Pulumi declares on its own: the stack itself and the providers.
const internalTypes = /^pulumi:(pulumi:Stack|providers:)/;

// A Pulumi engine event as a Hull progress event, or nothing for events the
// developer has no use for (debug and info chatter, internal resources).
export function progressFromEngineEvent(event: EngineEvent): ProgressEvent | undefined {
  const resource = event.resourcePreEvent
    ? { phase: "started" as const, metadata: event.resourcePreEvent.metadata }
    : event.resOutputsEvent
      ? { phase: "done" as const, metadata: event.resOutputsEvent.metadata }
      : event.resOpFailedEvent
        ? { phase: "failed" as const, metadata: event.resOpFailedEvent.metadata }
        : undefined;
  if (resource) {
    const { type, op, urn } = resource.metadata;
    if (internalTypes.test(type)) return undefined;
    return { phase: resource.phase, operation: op, type, name: urn.slice(urn.lastIndexOf("::") + 2) };
  }
  if (event.diagnosticEvent) {
    const { severity, message } = event.diagnosticEvent;
    return severity === "warning" || severity === "error" ? { phase: "diagnostic", severity, message } : undefined;
  }
  if (event.summaryEvent) {
    return { phase: "summary", changes: event.summaryEvent.resourceChanges, durationSeconds: event.summaryEvent.durationSeconds };
  }
  return undefined;
}
