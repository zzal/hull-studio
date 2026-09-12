// PROTOTYPE, throwaway. Non-interactive version of the spike question:
// change two values, print the unified diff. Pass = only those two lines differ.
import { readFileSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import { applyOps } from "./patch.ts";

const original = readFileSync(new URL("./blueprint.sample.yaml", import.meta.url), "utf8");

console.log("no-op round trip byte-identical:", applyOps(original, []) === original);

const edited = applyOps(original, [
  { op: "set", path: ["usage", "requestsPerMonth"], value: 250000 },
  { op: "set", path: ["intents", "api", "resolution"], value: "fargate-load-balancer" },
]);
const patch = createTwoFilesPatch("original", "edited", original, edited, "", "", { context: 0 });
console.log(patch);
const changed = patch.split("\n").filter((l) => /^[-+](?![-+])/.test(l));
console.log(`changed lines: ${changed.length} (expected 4: 2 removed, 2 added)`);
