// What every command needs from its surroundings, injected so tests can run
// the commands in a temporary directory, read what they print, and see which
// URL they open.
export type CommandContext = {
  cwd: string;
  output: (line: string) => void;
  openBrowser: (url: string) => Promise<void>;
  // Aborted to stop a command that would otherwise run until Ctrl+C.
  signal?: AbortSignal;
};
