import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Hull's working state under .hull: the committed state file, so a second
// machine deploys against the same state bucket, and the gitignored
// passphrase that unlocks that state. Both relative to the blueprint's
// directory.
const hullDirectory = ".hull";
export const stateFileName = join(hullDirectory, "state.json");
export const passphraseFileName = join(hullDirectory, "passphrase");

// The state bucket in the developer's account, one per account and region.
export const stateBucketName = (account: string, region: string) => `hull-state-${account}-${region}`;

const stateSchema = z.object({ stateBucket: z.string().min(1) });
export type DeployState = z.infer<typeof stateSchema>;

export function readState(directory: string): DeployState | undefined {
  const path = join(directory, stateFileName);
  if (!existsSync(path)) return undefined;
  const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${stateFileName} is not a Hull state file; it should hold { "stateBucket": "<bucket name>" }`);
  return parsed.data;
}

export function writeState(directory: string, state: DeployState): void {
  writeUnderHull(directory, stateFileName, `${JSON.stringify(state, null, 2)}\n`);
}

export function readPassphrase(directory: string): string | undefined {
  const path = join(directory, passphraseFileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

// 256 bits, readable by the owner only. A PoC choice (README): KMS is the
// intended later secrets provider.
export function generatePassphrase(directory: string): string {
  const passphrase = randomBytes(32).toString("base64url");
  writeUnderHull(directory, passphraseFileName, passphrase, 0o600);
  return passphrase;
}

function writeUnderHull(directory: string, name: string, content: string, mode?: number): void {
  mkdirSync(join(directory, hullDirectory), { recursive: true });
  writeFileSync(join(directory, name), content, { mode });
}
