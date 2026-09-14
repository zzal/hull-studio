import { runCommand, runMain } from "citty";
import open from "open";
import { createHull } from "./index.js";

// The binary. Help and version go through citty's own main; a command runs
// directly so that, when it fails, the message alone reaches stderr (no
// stack trace) and the process exits 1.

const hull = createHull({
  cwd: process.cwd(),
  output: (line) => console.log(line),
  openBrowser: async (url) => {
    await open(url);
  },
});

const rawArgs = process.argv.slice(2);
if (rawArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "--version")) {
  await runMain(hull, { rawArgs });
} else {
  try {
    await runCommand(hull, { rawArgs });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
