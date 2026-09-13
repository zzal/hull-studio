import { runMain } from "citty";
import open from "open";
import { createHull } from "./index.js";

await runMain(
  createHull({
    cwd: process.cwd(),
    output: (line) => console.log(line),
    openBrowser: async (url) => {
      await open(url);
    },
  }),
);
