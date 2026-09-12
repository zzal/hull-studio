// PROTOTYPE, throwaway. Thin terminal shell over patch.ts.
// Question: does every edit produce a diff that touches only the edited lines?
import { readFileSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import { applyOps, readPath, type Op } from "./patch.ts";

const ESC = String.fromCharCode(27);
const B = ESC + "[1m", D = ESC + "[2m", R = ESC + "[0m", G = ESC + "[32m", Rd = ESC + "[31m";
const CTRL_C = String.fromCharCode(3);

const original = readFileSync(new URL("./blueprint.sample.yaml", import.meta.url), "utf8");
let current = original;
let log: string[] = [];

function apply(label: string, ops: Op[]) {
  current = applyOps(current, ops);
  log.push(label);
}

const actions: Record<string, [string, () => void]> = {
  r: ["double usage.requestsPerMonth", () => {
    const v = readPath(current, ["usage", "requestsPerMonth"]) as number;
    apply(`requestsPerMonth -> ${v * 2}`, [{ op: "set", path: ["usage", "requestsPerMonth"], value: v * 2 }]);
  }],
  t: ["toggle api resolution lambda <-> fargate (key with trailing comment)", () => {
    const v = readPath(current, ["intents", "api", "resolution"]);
    const next = v === "lambda-api-gateway" ? "fargate-load-balancer" : "lambda-api-gateway";
    apply(`api.resolution -> ${next}`, [{ op: "set", path: ["intents", "api", "resolution"], value: next }]);
  }],
  m: ["add override prod.db.multiAz: true (new key)", () => {
    apply("add prod override multiAz", [{ op: "set", path: ["environments", "prod", "overrides", "db", "multiAz"], value: true }]);
  }],
  x: ["delete override prod.db.instanceClass (key with comment above)", () => {
    apply("delete prod override instanceClass", [{ op: "delete", path: ["environments", "prod", "overrides", "db", "instanceClass"] }]);
  }],
  d: ["add override to dev (currently an empty flow mapping)", () => {
    apply("add dev override", [{ op: "set", path: ["environments", "dev", "overrides", "db", "instanceClass"], value: "db.t4g.micro" }]);
  }],
  l: ["add a second link api -> cache (sequence with a comment)", () => {
    apply("add link", [{ op: "set", path: ["intents", "api", "links", 1], value: { to: "cache", role: "read" } }]);
  }],
  s: ["change region (key with trailing comment)", () => {
    apply("region -> eu-west-1", [{ op: "set", path: ["region"], value: "eu-west-1" }]);
  }],
  u: ["reset to original", () => { current = original; log = []; }],
};

function render() {
  console.clear();
  const patch = createTwoFilesPatch("original", "current", original, current, "", "", { context: 1 });
  const body = patch.split("\n").slice(4).map((l) =>
    l.startsWith("+") ? G + l + R : l.startsWith("-") ? Rd + l + R : l.startsWith("@@") ? D + l + R : l
  ).join("\n");
  const changed = patch.split("\n").filter((l) => /^[-+](?![-+])/.test(l)).length;
  console.log(`${B}Diff vs original${R}  ${D}(${changed} changed lines, ${log.length} edits applied)${R}\n`);
  console.log(body.trim() === "" ? `${D}(identical)${R}` : body);
  console.log(`\n${B}Edits:${R} ${D}${log.join(" | ") || "none"}${R}\n`);
  for (const [k, [desc]] of Object.entries(actions)) console.log(`  ${B}[${k}]${R} ${D}${desc}${R}`);
  console.log(`  ${B}[q]${R} ${D}quit${R}`);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  if (key === "q" || key === CTRL_C) { process.stdin.setRawMode(false); process.exit(0); }
  actions[key]?.[1]();
  render();
});
render();
