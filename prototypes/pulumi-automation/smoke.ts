// PROTOTYPE, throwaway. Spike 2 of milestone 1.
// Question: from a TS script, can LocalWorkspace + an inline program + an
// s3:// backend in the user's own account run `up` then `destroy` for one
// trivial resource, streaming progress events? And what does the Pulumi CLI
// dependency look like in practice?
//
// Env: AWS_PROFILE (default aws-examples), AWS_REGION (default ca-central-1),
//      KEEP_STATE_BUCKET=1 to leave the state bucket behind.
import { LocalWorkspace, PulumiCommand, type EngineEvent } from "@pulumi/pulumi/automation";
import * as aws from "@pulumi/aws";
import {
  S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand,
  PutPublicAccessBlockCommand, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const profile = process.env.AWS_PROFILE ?? "aws-examples";
const region = process.env.AWS_REGION ?? "ca-central-1";
process.env.AWS_PROFILE = profile;
process.env.AWS_REGION = region;
const passphrase = "hull-prototype-not-a-secret";
const timings: Record<string, number> = {};
const t = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const s = Date.now();
  try { return await fn(); } finally { timings[label] = Date.now() - s; }
};
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 1. CLI dependency
const cmd = await t("cli check", () => PulumiCommand.get());
log(`pulumi CLI ${cmd.version} at ${cmd.command} (Automation API can also PulumiCommand.install() into ~/.pulumi/versions)`);

// 2. identity
const sts = new STSClient({ region });
const id = await t("sts identity", () => sts.send(new GetCallerIdentityCommand({})));
log(`account ${id.Account} via profile ${profile}, region ${region}`);

// 3. state bucket bootstrap
const s3 = new S3Client({ region });
const stateBucket = `hull-state-${id.Account}-${region}`;
const bucketExists = await t("state bucket check", async () => {
  try { await s3.send(new HeadBucketCommand({ Bucket: stateBucket })); return true; }
  catch (e: any) { if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") return false; throw e; }
});
if (!bucketExists) {
  await t("state bucket create", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: stateBucket, CreateBucketConfiguration: { LocationConstraint: region as any } }));
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: stateBucket, PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: stateBucket, VersioningConfiguration: { Status: "Enabled" } }));
  });
}
log(`state bucket ${stateBucket} ${bucketExists ? "already existed" : "created (versioned, public access blocked)"}`);

// 4. inline program: one bucket
const program = async () => {
  const b = new aws.s3.Bucket("hull-spike", { forceDestroy: true, tags: { hull: "prototype-spike-2" } });
  return { bucketName: b.bucket, arn: b.arn };
};

// 5. workspace + stack against the s3 backend
const stack = await t("workspace + stack", () => LocalWorkspace.createOrSelectStack(
  { stackName: "spike", projectName: "hull-spike", program },
  {
    projectSettings: { name: "hull-spike", runtime: "nodejs", backend: { url: `s3://${stateBucket}?region=${region}` } },
    secretsProvider: "passphrase",
    envVars: { PULUMI_CONFIG_PASSPHRASE: passphrase, AWS_PROFILE: profile, AWS_REGION: region },
    pulumiCommand: cmd,
  },
));
log(`stack ${stack.name} ready, backend user: ${JSON.stringify(await stack.workspace.whoAmI())}`);
await stack.setConfig("aws:region", { value: region });

// 6. event stream plumbing
const counts: Record<string, number> = {};
const onEvent = (e: EngineEvent) => {
  const kind = Object.keys(e).find((k) => k.endsWith("Event")) ?? "unknown";
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (e.resourcePreEvent) { const m = e.resourcePreEvent.metadata; log(`  pre     ${m.op.padEnd(8)} ${m.type} ${m.urn.split("::").pop()}`); }
  if (e.resOutputsEvent) { const m = e.resOutputsEvent.metadata; log(`  done    ${m.op.padEnd(8)} ${m.type} ${m.urn.split("::").pop()}`); }
  if (e.resOpFailedEvent) log(`  FAILED  ${e.resOpFailedEvent.metadata.type}`);
  if (e.diagnosticEvent && e.diagnosticEvent.severity !== "debug") log(`  diag(${e.diagnosticEvent.severity}) ${e.diagnosticEvent.message.trim().slice(0, 200)}`);
  if (e.summaryEvent) log(`  summary ${JSON.stringify(e.summaryEvent.resourceChanges)} in ${e.summaryEvent.durationSeconds}s`);
};

// 7. up, then destroy no matter what
try {
  const up = await t("up", () => stack.up({ onEvent, color: "never" }));
  log(`up: ${up.summary.result}, outputs ${JSON.stringify(up.outputs.bucketName?.value)} ${JSON.stringify(up.outputs.arn?.value)}`);
} finally {
  const d = await t("destroy", () => stack.destroy({ onEvent, color: "never" }));
  log(`destroy: ${d.summary.result}`);
  await t("remove stack", () => stack.workspace.removeStack("spike"));
  log("stack removed from backend");
}

// 8. clean up the state bucket (versioned: delete every version and marker)
if (process.env.KEEP_STATE_BUCKET !== "1") {
  await t("state bucket delete", async () => {
    let KeyMarker: string | undefined, VersionIdMarker: string | undefined, n = 0;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({ Bucket: stateBucket, KeyMarker, VersionIdMarker }));
      const objs = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key!, VersionId: o.VersionId }));
      if (objs.length) { await s3.send(new DeleteObjectsCommand({ Bucket: stateBucket, Delete: { Objects: objs, Quiet: true } })); n += objs.length; }
      KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
    } while (KeyMarker || VersionIdMarker);
    await s3.send(new DeleteBucketCommand({ Bucket: stateBucket }));
    log(`state bucket deleted (${n} object versions removed)`);
  });
} else {
  log(`state bucket kept: ${stateBucket}`);
}

// 9. summary
console.log("\nevents seen:", counts);
console.log("timings (ms):");
for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(22)} ${String(v).padStart(7)}`);
