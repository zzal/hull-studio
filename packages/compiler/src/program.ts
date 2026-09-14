import { sizingValues, type MergedBlueprint, type MergedIntent } from "@hull/blueprint";
import { lambdaSizingSchema, rdsSizingSchema, type LambdaSizing, type RdsSizing } from "@hull/catalog";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { z } from "zod";
import { nodeRuntime, type Bundle } from "./bundle.js";
import { CompileError } from "./errors.js";
import { databaseLinkVariables } from "./link.js";

// The compiler's input: the blueprint merged for one environment, sizing
// included, and the bundle of every tier, by intent name.
export type CompileInput = {
  blueprint: MergedBlueprint;
  bundles: Record<string, Bundle>;
};

// An inline Pulumi program, as the Automation API takes it: called inside a
// stack, it declares the resources and returns the stack outputs.
export type Program = () => Promise<StackOutputs>;
export type StackOutputs = { apiUrl?: pulumi.Output<string> };

// What v0 deploys: rds-postgres and lambda-api-gateway on a default VPC, and
// the read-write link between them as one security group rule, one IAM
// statement and the HULL_<INTENT>_* variables on the Lambda. No NAT gateway:
// the Lambda only needs the database.
type Target = "database" | "lambda";
const deployable: Record<string, Target | undefined> = {
  "rds-postgres": "database",
  "lambda-api-gateway": "lambda",
};

const postgresPort = 5432;
const bundleFileName = "index.mjs";
// The AWS-managed policy that lets a Lambda attach to a VPC and write logs.
const vpcAccessPolicyArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";
const logRetentionDays = 14;

// Refuses up front, before any resource is declared, what the program could
// not deploy; the program itself only runs inside a Pulumi stack.
export function compileProgram({ blueprint, bundles }: CompileInput): Program {
  const databases: { name: string; sizing: RdsSizing }[] = [];
  const lambdas: { name: string; sizing: LambdaSizing; bundle: Bundle; links: string[] }[] = [];
  for (const [name, intent] of Object.entries(blueprint.intents)) {
    const target = deployable[intent.resolution];
    if (!target) throw new CompileError(`intent "${name}" resolves to ${intent.resolution}, which is not deployable in this version`);
    if (target === "database") {
      databases.push({ name, sizing: sizingOf(rdsSizingSchema, name, intent) });
    } else {
      const bundle = bundles[name];
      if (bundle === undefined) throw new CompileError(`no bundle for intent "${name}"`);
      const links = intent.kind === "http-api" ? (intent.links ?? []).map((link) => link.to) : [];
      lambdas.push({ name, sizing: sizingOf(lambdaSizingSchema, name, intent), bundle, links });
    }
  }
  if (lambdas.length > 1) {
    throw new CompileError(`this version deploys one http-api intent; the blueprint has ${lambdas.map(({ name }) => name).join(", ")}`);
  }
  for (const { name, links } of lambdas) {
    for (const to of links) {
      if (!databases.some((database) => database.name === to)) {
        throw new CompileError(`intent "${name}" links to "${to}", which is not a database this version deploys`);
      }
    }
  }

  return async () => {
    const vpc = await aws.ec2.getVpc({ default: true });
    const subnets = await aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] });
    const network = { vpcId: vpc.id, subnetIds: subnets.ids };

    const declared = new Map(
      databases.map(({ name, sizing }) => [name, declareRdsPostgres(name, sizing, network, blueprint.name)]),
    );
    const outputs: StackOutputs = {};
    for (const { name, sizing, bundle, links } of lambdas) {
      const linked = links.map((to) => ({ to, database: declared.get(to)! }));
      outputs.apiUrl = declareLambdaApi(name, sizing, bundle, network, linked);
    }
    return outputs;
  };
}

// An override the vocabulary check let through can still be a value the
// resolution's schema refuses; that is the blueprint's fault, not a bug.
function sizingOf<S extends z.ZodType>(schema: S, name: string, intent: MergedIntent): z.infer<S> {
  const parsed = schema.safeParse(sizingValues(intent.sizing));
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new CompileError(`intent "${name}" has an invalid sizing: ${issue?.path.join(".")} ${issue?.message}`);
  }
  return parsed.data;
}

type Network = { vpcId: string; subnetIds: string[] };

type Database = {
  group: aws.ec2.SecurityGroup;
  instance: aws.rds.Instance;
  secretArn: pulumi.Output<string>;
};

// A Postgres database name is letters, digits and underscores, starting
// with a letter; the application name is free-form.
function databaseName(applicationName: string): string {
  const safe = applicationName.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(safe) ? safe : `db_${safe}`;
}

// The database group takes no traffic of its own; each link adds the one
// rule that lets its tier in. The database is private, sized as merged, and
// its master password lives in Secrets Manager under AWS's management. No
// final snapshot: `hull destroy` must leave nothing behind.
function declareRdsPostgres(name: string, sizing: RdsSizing, network: Network, applicationName: string): Database {
  const group = new aws.ec2.SecurityGroup(name, { vpcId: network.vpcId, description: `Hull: ${name} database` });
  const instance = new aws.rds.Instance(name, {
    engine: "postgres",
    instanceClass: sizing.instanceClass,
    allocatedStorage: sizing.storageGb,
    storageType: "gp3",
    multiAz: sizing.multiAz,
    dbName: databaseName(applicationName),
    username: "postgres",
    manageMasterUserPassword: true,
    publiclyAccessible: false,
    vpcSecurityGroupIds: [group.id],
    skipFinalSnapshot: true,
  });
  // The managed secret is an output of the instance, never an input; a
  // missing one is a provider surprise, not a blueprint fault.
  const secretArn = instance.masterUserSecrets.apply((secrets) => {
    const [secret] = secrets;
    if (!secret) throw new Error(`the database ${name} has no managed master password secret`);
    return secret.secretArn;
  });
  return { group, instance, secretArn };
}

type LinkedDatabase = { to: string; database: Database };

// The tier's group may reach anything outbound; each link opens the target
// group to it on the Postgres port, lets its role read the target's secret,
// and hands it the connection details as HULL_<INTENT>_* variables.
function declareLambdaApi(
  name: string,
  sizing: LambdaSizing,
  bundle: Bundle,
  network: Network,
  links: LinkedDatabase[],
): pulumi.Output<string> {
  const group = new aws.ec2.SecurityGroup(name, {
    vpcId: network.vpcId,
    description: `Hull: ${name} tier`,
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  });

  const role = new aws.iam.Role(name, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
  });
  new aws.iam.RolePolicyAttachment(name, { role: role.name, policyArn: vpcAccessPolicyArn });

  const variables: Record<string, pulumi.Input<string>> = {};
  for (const { to, database } of links) {
    new aws.ec2.SecurityGroupRule(`${name}-${to}`, {
      type: "ingress",
      securityGroupId: database.group.id,
      sourceSecurityGroupId: group.id,
      protocol: "tcp",
      fromPort: postgresPort,
      toPort: postgresPort,
    });
    new aws.iam.RolePolicy(`${name}-${to}`, {
      role: role.name,
      policy: database.secretArn.apply((secretArn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn }],
        }),
      ),
    });
    const names = databaseLinkVariables(to);
    variables[names.host] = database.instance.address;
    variables[names.port] = database.instance.port.apply(String);
    variables[names.name] = database.instance.dbName;
    variables[names.user] = database.instance.username;
    variables[names.passwordArn] = database.secretArn;
  }

  // The Lambda's own log group, declared rather than left for the runtime
  // to create on first invocation: what the stack creates, destroy removes.
  const logs = new aws.cloudwatch.LogGroup(name, { retentionInDays: logRetentionDays });
  const lambda = new aws.lambda.Function(name, {
    runtime: nodeRuntime,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({ [bundleFileName]: new pulumi.asset.StringAsset(bundle.code) }),
    role: role.arn,
    memorySize: sizing.memoryMb,
    timeout: sizing.timeoutSeconds,
    vpcConfig: { subnetIds: network.subnetIds, securityGroupIds: [group.id] },
    environment: { variables },
    loggingConfig: { logFormat: "Text", logGroup: logs.name },
  });

  const api = new aws.apigatewayv2.Api(name, { protocolType: "HTTP" });
  const integration = new aws.apigatewayv2.Integration(name, {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationUri: lambda.invokeArn,
    payloadFormatVersion: "2.0",
  });
  new aws.apigatewayv2.Route(name, {
    apiId: api.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
  });
  new aws.apigatewayv2.Stage(name, { apiId: api.id, name: "$default", autoDeploy: true });
  new aws.lambda.Permission(name, {
    action: "lambda:InvokeFunction",
    function: lambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
  });

  return api.apiEndpoint;
}
