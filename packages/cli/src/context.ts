import type { DeployEngine, ProviderAccount } from "./deploy/engine.js";

// What every command needs from its surroundings, injected so tests can run
// the commands in a temporary directory, read what they print, see which
// URL they open, and deploy against a fake engine and a fake account.
export type CommandContext = {
  cwd: string;
  output: (line: string) => void;
  openBrowser: (url: string) => Promise<void>;
  // Asks the developer a yes-or-no question; absent when no terminal can
  // answer, which is when a deploy needs --yes.
  confirm?: (question: string) => Promise<boolean>;
  // Aborted to stop a command that would otherwise run until Ctrl+C.
  signal?: AbortSignal;
  // Pulumi and the developer's AWS account unless given otherwise.
  engine?: DeployEngine;
  provider?: ProviderAccount;
};
