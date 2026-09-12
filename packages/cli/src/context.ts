// What every command needs from its surroundings, injected so tests can run
// the commands in a temporary directory and read what they print.
export type CommandContext = {
  cwd: string;
  output: (line: string) => void;
};
