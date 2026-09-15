// PROTOTYPE, throwaway. Phase 0 of milestone 2: from a Lambda attached to
// the default VPC with no NAT gateway, call Secrets Manager and SQS, first
// with no VPC endpoint, then with an interface endpoint per service, and
// print what happens. Local file backend, passphrase "spike"; destroys
// everything at the end. Run: `pnpm install && AWS_PROFILE=<sandbox> pnpm start`.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";

const region = process.env.AWS_REGION ?? "us-east-1";
const callTimeoutMs = 5000;

// The function under test: one call to each service with a short timeout,
// answering with the outcome of each. Node 22 runtime, AWS SDK v3 built in.
const handlerSource = `
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { SQSClient, GetQueueAttributesCommand } = require("@aws-sdk/client-sqs");
const timeout = ${callTimeoutMs};
async function attempt(name, call) {
  const started = Date.now();
  try {
    await Promise.race([call(), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after " + timeout + " ms")), timeout))]);
    return { name, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - started, error: String(error && error.message || error) };
  }
}
exports.handler = async () => {
  const secrets = new SecretsManagerClient({});
  const sqs = new SQSClient({});
  return [
    await attempt("secretsmanager:GetSecretValue", () => secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))),
    await attempt("sqs:GetQueueAttributes", () => sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.QUEUE_URL, AttributeNames: ["QueueArn"] }))),
  ];
};
`;

// The program, with or without the two interface endpoints.
function program(withEndpoints: boolean) {
  return async () => {
    const vpc = await aws.ec2.getVpc({ default: true });
    const subnets = await aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] });
    const group = new aws.ec2.SecurityGroup("spike", {
      vpcId: vpc.id,
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
      ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, self: true }],
    });
    const secret = new aws.secretsmanager.Secret("spike", { recoveryWindowInDays: 0 });
    new aws.secretsmanager.SecretVersion("spike", { secretId: secret.id, secretString: JSON.stringify({ password: "spike" }) });
    const queue = new aws.sqs.Queue("spike");
    const role = new aws.iam.Role("spike", {
      assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
    });
    new aws.iam.RolePolicyAttachment("spike", { role: role.name, policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole" });
    new aws.iam.RolePolicy("spike", {
      role: role.name,
      policy: pulumi.all([secret.arn, queue.arn]).apply(([secretArn, queueArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn },
            { Effect: "Allow", Action: ["sqs:GetQueueAttributes"], Resource: queueArn },
          ],
        }),
      ),
    });
    const fn = new aws.lambda.Function("spike", {
      runtime: "nodejs22.x",
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset(handlerSource) }),
      role: role.arn,
      timeout: 30,
      vpcConfig: { subnetIds: subnets.ids, securityGroupIds: [group.id] },
      environment: { variables: { SECRET_ARN: secret.arn, QUEUE_URL: queue.url } },
    });
    if (withEndpoints) {
      // One subnet each: reachable from every subnet of the VPC through
      // private DNS; the milestone counts one availability zone per endpoint.
      for (const service of ["secretsmanager", "sqs"]) {
        new aws.ec2.VpcEndpoint(service, {
          vpcId: vpc.id,
          serviceName: `com.amazonaws.${region}.${service}`,
          vpcEndpointType: "Interface",
          subnetIds: [subnets.ids[0]!],
          securityGroupIds: [group.id],
          privateDnsEnabled: true,
        });
      }
    }
    return { functionName: fn.name };
  };
}

async function invoke(functionName: string) {
  const lambda = new LambdaClient({ region });
  const result = await lambda.send(new InvokeCommand({ FunctionName: functionName }));
  return JSON.parse(Buffer.from(result.Payload ?? []).toString("utf8")) as { name: string; ok: boolean; ms: number; error?: string }[];
}

const stack = await LocalWorkspace.createOrSelectStack(
  { projectName: "hull-vpc-reach", stackName: "spike", program: program(false) },
  { projectSettings: { name: "hull-vpc-reach", runtime: "nodejs", backend: { url: "file://~" } }, envVars: { PULUMI_CONFIG_PASSPHRASE: "spike", AWS_REGION: region } },
);
await stack.setConfig("aws:region", { value: region });

try {
  console.log("== no endpoints");
  const first = await stack.up({ color: "never", onOutput: () => undefined });
  console.log(JSON.stringify(await invoke(first.outputs.functionName!.value as string), null, 2));

  console.log("== one interface endpoint per service");
  const second = await stack.up({ color: "never", program: program(true), onOutput: () => undefined });
  console.log(JSON.stringify(await invoke(second.outputs.functionName!.value as string), null, 2));
} finally {
  console.log("== destroying");
  await stack.destroy({ color: "never", onOutput: () => undefined });
  await stack.workspace.removeStack("spike");
}
