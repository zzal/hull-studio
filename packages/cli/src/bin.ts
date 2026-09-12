import { runMain } from "citty";
import { createHull } from "./index.js";

await runMain(createHull({ cwd: process.cwd(), output: (line) => console.log(line) }));
