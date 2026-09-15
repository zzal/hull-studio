import { isTier, sizingValues, type MergedBlueprint, type MergedIntent } from "@hull/blueprint";
import {
  lambdaSizingSchema,
  lambdaWorkerSizingSchema,
  rdsSizingSchema,
  sqsSizingSchema,
  type LambdaSizing,
  type LambdaWorkerSizing,
  type RdsSizing,
  type SqsSizing,
} from "@hull/catalog";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { z } from "zod";
import { nodeRuntime, type Bundle } from "./bundle.js";
import { CompileError } from "./errors.js";
import { databaseLinkVariables, queueLinkVariables } from "./link.js";

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

// What this version deploys: rds-postgres, sqs-standard, and the two Lambda
// tiers, on a default VPC. A tier is attached to the VPC only when it links
// a database; a link is one IAM statement set and the HULL_<INTENT>_*
// variables on the tier, plus for a database the security group rule that
// lets the tier in. No NAT gateway (ADR 0008).
type Target = "database" | "queue" | "api" | "worker";
const deployable: Record<string, Target | undefined> = {
  "rds-postgres": "database",
  "sqs-standard": "queue",
  "lambda-api-gateway": "api",
  "lambda-worker": "worker",
};

const postgresPort = 5432;
const bundleFileName = "index.mjs";
// The AWS-managed policies that let a Lambda write logs, with and without a
// VPC attachment.
const vpcAccessPolicyArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";
const basicExecutionPolicyArn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const logRetentionDays = 14;
// Every queue redrives to its dead-letter queue after this many receives,
// and the dead-letter queue keeps a message this long.
const deadLetterMaxReceiveCount = 5;
const deadLetterRetentionDays = 14;
const secondsPerDay = 24 * 3600;

type Link = { to: string; role: string };
type DeployableTier =
  | { name: string; kind: "api"; sizing: LambdaSizing; bundle: Bundle; links: Link[] }
  | { name: string; kind: "worker"; sizing: LambdaWorkerSizing; bundle: Bundle; links: Link[] };

// Refuses up front, before any resource is declared, what the program could
// not deploy; the program itself only runs inside a Pulumi stack.
export function compileProgram({ blueprint, bundles }: CompileInput): Program {
  const databases: { name: string; sizing: RdsSizing }[] = [];
  const queues: { name: string; sizing: SqsSizing }[] = [];
  const tiers: DeployableTier[] = [];
  for (const [name, intent] of Object.entries(blueprint.intents)) {
    const target = deployable[intent.resolution];
    if (!target) throw new CompileError(`intent "${name}" resolves to ${intent.resolution}, which is not deployable in this version`);
    if (target === "database") {
      databases.push({ name, sizing: sizingOf(rdsSizingSchema, name, intent) });
    } else if (target === "queue") {
      queues.push({ name, sizing: sizingOf(sqsSizingSchema, name, intent) });
    } else {
      const bundle = bundles[name];
      if (bundle === undefined) throw new CompileError(`no bundle for intent "${name}"`);
      const links = isTier(intent) ? (intent.links ?? []) : [];
      tiers.push(
        target === "api"
          ? { name, kind: "api", sizing: sizingOf(lambdaSizingSchema, name, intent), bundle, links }
          : { name, kind: "worker", sizing: sizingOf(lambdaWorkerSizingSchema, name, intent), bundle, links },
      );
    }
  }
  const apis = tiers.filter((tier) => tier.kind === "api");
  if (apis.length > 1) {
    throw new CompileError(`this version deploys one http-api intent; the blueprint has ${apis.map(({ name }) => name).join(", ")}`);
  }
  for (const { name, links } of tiers) {
    for (const { to, role } of links) {
      const isQueue = queues.some((queue) => queue.name === to);
      if (!databases.some((database) => database.name === to) && !isQueue) {
        throw new CompileError(`intent "${name}" links to "${to}", which is not a database or a queue this version deploys`);
      }
      if (isQueue && !(role in queueActions)) {
        throw new CompileError(`intent "${name}" links to "${to}" with role ${role}, which this version does not deploy; queue roles are ${Object.keys(queueActions).join(", ")}`);
      }
    }
  }

  return async () => {
    const vpc = await aws.ec2.getVpc({ default: true });
    const subnets = await aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] });
    const network = { vpcId: vpc.id, subnetIds: subnets.ids };

    const declaredDatabases = new Map(databases.map(({ name, sizing }) => [name, declareRdsPostgres(name, sizing, network, blueprint.name)]));
    const declaredQueues = new Map(queues.map(({ name, sizing }) => [name, declareSqsStandard(name, sizing)]));
    const outputs: StackOutputs = {};
    for (const tier of tiers) {
      const linked = tier.links.map((link) => ({
        ...link,
        database: declaredDatabases.get(link.to),
        queue: declaredQueues.get(link.to),
      }));
      const lambda = declareTier(tier, network, linked);
      if (tier.kind === "api") outputs.apiUrl = declareHttpApi(tier.name, lambda);
      else declareEventSources(tier.name, lambda, tier.sizing, linked);
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

type Queue = aws.sqs.Queue;

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

// A standard queue sized as merged, and the dead-letter queue every queue
// gets: a poison message that blocks a worker forever is the failure a
// first-time user cannot diagnose. The dead-letter queue is part of what
// sqs-standard means, not an intent.
function declareSqsStandard(name: string, sizing: SqsSizing): Queue {
  const deadLetter = new aws.sqs.Queue(`${name}-dead-letter`, { messageRetentionSeconds: deadLetterRetentionDays * secondsPerDay });
  return new aws.sqs.Queue(name, {
    visibilityTimeoutSeconds: sizing.visibilityTimeoutSeconds,
    messageRetentionSeconds: sizing.retentionDays * secondsPerDay,
    redrivePolicy: deadLetter.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: deadLetterMaxReceiveCount })),
  });
}

type LinkedIntent = Link & { database?: Database; queue?: Queue };

// The IAM statements a link grants its tier: exactly what the role needs,
// per direction. A consume link also covers what the event source mapping
// polls with, since the mapping runs under the function's role. Checked
// before any resource is declared.
const queueActions: Record<string, string[]> = {
  produce: ["sqs:SendMessage"],
  consume: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
};

// The tier's role, one policy per link, its log group and the function
// from its bundle. Attached to the VPC, with a group that may reach
// anything outbound, only when a database is linked; a tier that only
// talks to queues stays outside and pays nothing for the attachment.
function declareTier(tier: DeployableTier, network: Network, links: LinkedIntent[]): aws.lambda.Function {
  const { name, sizing, bundle } = tier;
  const inVpc = links.some((link) => link.database !== undefined);
  const group = inVpc
    ? new aws.ec2.SecurityGroup(name, {
        vpcId: network.vpcId,
        description: `Hull: ${name} tier`,
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
      })
    : undefined;

  const role = new aws.iam.Role(name, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
  });
  new aws.iam.RolePolicyAttachment(name, { role: role.name, policyArn: inVpc ? vpcAccessPolicyArn : basicExecutionPolicyArn });

  const variables: Record<string, pulumi.Input<string>> = {};
  for (const { to, role: linkRole, database, queue } of links) {
    if (database) {
      new aws.ec2.SecurityGroupRule(`${name}-${to}`, {
        type: "ingress",
        securityGroupId: database.group.id,
        sourceSecurityGroupId: group!.id,
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
    } else if (queue) {
      const actions = queueActions[linkRole]!;
      new aws.iam.RolePolicy(`${name}-${to}`, {
        role: role.name,
        policy: queue.arn.apply((arn) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: arn }] })),
      });
      const names = queueLinkVariables(to);
      variables[names.url] = queue.url;
      variables[names.arn] = queue.arn;
    }
  }

  // The Lambda's own log group, declared rather than left for the runtime
  // to create on first invocation: what the stack creates, destroy removes.
  const logs = new aws.cloudwatch.LogGroup(name, { retentionInDays: logRetentionDays });
  return new aws.lambda.Function(name, {
    runtime: nodeRuntime,
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({ [bundleFileName]: new pulumi.asset.StringAsset(bundle.code) }),
    role: role.arn,
    memorySize: sizing.memoryMb,
    timeout: sizing.timeoutSeconds,
    ...(group && { vpcConfig: { subnetIds: network.subnetIds, securityGroupIds: [group.id] } }),
    environment: { variables },
    loggingConfig: { logFormat: "Text", logGroup: logs.name },
  });
}

// Every request of an HTTP API routed to the Lambda; the URL is the stack's output.
function declareHttpApi(name: string, lambda: aws.lambda.Function): pulumi.Output<string> {
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

// The worker is fed by every queue it consumes: batch size and maximum
// concurrency from the sizing, partial batch failures reported so one bad
// message does not redeliver the good ones of its batch.
function declareEventSources(name: string, lambda: aws.lambda.Function, sizing: LambdaWorkerSizing, links: LinkedIntent[]): void {
  for (const { to, role, queue } of links) {
    if (!queue || role !== "consume") continue;
    new aws.lambda.EventSourceMapping(`${name}-${to}`, {
      eventSourceArn: queue.arn,
      functionName: lambda.name,
      batchSize: sizing.batchSize,
      scalingConfig: { maximumConcurrency: sizing.maxConcurrency },
      functionResponseTypes: ["ReportBatchItemFailures"],
    });
  }
}
