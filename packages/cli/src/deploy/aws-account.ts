import type { BucketLocationConstraint } from "@aws-sdk/client-s3";
import type { ProviderAccount } from "./engine.js";

// The AWS profile the SDK and the Pulumi CLI both read; unset means the
// default one.
export const ambientProfile = () => process.env.AWS_PROFILE;

// The developer's AWS account through the SDK, with credentials from the
// ambient profile. Loaded on first use, like the engine.
export function awsAccount(): ProviderAccount {
  const profile = () => ambientProfile() ?? "default";

  return {
    async identity(region) {
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      let account: string | undefined;
      try {
        ({ Account: account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({})));
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `no AWS credentials found for profile "${profile()}" in region ${region} (${cause}); log in with the AWS CLI or set AWS_PROFILE, then run \`hull deploy\` again`,
        );
      }
      if (!account) throw new Error(`AWS answered without an account id for profile "${profile()}" in region ${region}`);
      return { account, profile: profile() };
    },

    async ensureStateBucket(name, region) {
      const s3 = await import("@aws-sdk/client-s3");
      const client = new s3.S3Client({ region });
      try {
        await client.send(new s3.HeadBucketCommand({ Bucket: name }));
        return "existed";
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      // us-east-1 is the one region that refuses its own location constraint.
      await client.send(
        new s3.CreateBucketCommand({
          Bucket: name,
          ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
        }),
      );
      await client.send(
        new s3.PutPublicAccessBlockCommand({
          Bucket: name,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      );
      await client.send(new s3.PutBucketVersioningCommand({ Bucket: name, VersioningConfiguration: { Status: "Enabled" } }));
      return "created";
    },
  };
}

function isNotFound(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return failure.name === "NotFound" || failure.$metadata?.httpStatusCode === 404;
}
