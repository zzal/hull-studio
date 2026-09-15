import { createInterface } from "node:readline/promises";
import { runCommand, runMain } from "citty";
import open from "open";
import { createHull } from "./index.js";

// The binary. Help and version go through citty's own main; a command runs
// directly so that, when it fails, the message alone reaches stderr (no
// stack trace) and the process exits 1.

// A yes-or-no question on the terminal; only when one is attached, so a
// script without --yes is refused rather than left waiting.
const interactive = process.stdin.isTTY && process.stdout.isTTY;
async function confirm(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

const hull = createHull({
  cwd: process.cwd(),
  output: (line) => console.log(line),
  openBrowser: async (url) => {
    await open(url);
  },
  ...(interactive && { confirm }),
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
