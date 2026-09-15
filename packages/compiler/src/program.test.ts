import { mergeEnvironment, type Blueprint } from "@hull/blueprint";
import { deriveSizing, resources } from "@hull/catalog";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, compileProgram, type CompileInput } from "./index.js";

// Seam: the inline Pulumi program, run in-process under Pulumi's mock
// runtime. Every resource the program declares lands in `declared` with the
// inputs it was given; nothing reaches AWS.

type Declared = { type: string; name: string; inputs: Record<string, unknown> };
const declared: Declared[] = [];

const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-1";

await pulumi.runtime.setMocks(
  {
    newResource(args) {
      declared.push({ type: args.type, name: args.name, inputs: args.inputs });
      const extra: Record<string, unknown> =
        args.type === "aws:rds/instance:Instance"
          ? { address: "db.internal", port: 5432, masterUserSecrets: [{ secretArn }] }
          : args.type === "aws:apigatewayv2/api:Api"
            ? { apiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", executionArn: "arn:aws:execute-api:us-east-1:123456789012:abc" }
            : args.type === "aws:sqs/queue:Queue"
              ? { url: `https://sqs.us-east-1.amazonaws.com/123456789012/${args.name}` }
              : {};
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, name: args.name, arn: `arn:${args.name}`, invokeArn: `invoke:${args.name}`, ...extra },
      };
    },
    call(args) {
      if (args.token === "aws:ec2/getVpc:getVpc") return { id: "vpc-1" };
      if (args.token === "aws:ec2/getSubnets:getSubnets") return { ids: ["subnet-a", "subnet-b"] };
      throw new Error(`unexpected provider call ${args.token}`);
    },
  },
  "hull",
  "dev",
  false,
);

const sample: Blueprint = {
  name: "todos",
  provider: "aws",
  region: "us-east-1",
  usage: { requestsPerMonth: 100000, storageGb: 1 },
  intents: {
    api: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/api/index.ts", links: [{ to: "db", role: "read-write" }] },
    db: { kind: "relational-database", resolution: "rds-postgres" },
  },
  environments: { dev: {}, prod: { usage: { requestsPerMonth: 20000000 }, overrides: { db: { instanceClass: "db.t4g.large" } } } },
};

// The milestone 2 plan's demo blueprint: a queue produced by the API and
// consumed by a worker that also reads the database.
const demo: Blueprint = {
  name: "todos",
  provider: "aws",
  region: "us-east-1",
  usage: { requestsPerMonth: 100000, storageGb: 1, messagesPerMonth: 100000 },
  intents: {
    api: {
      kind: "http-api",
      resolution: "lambda-api-gateway",
      entry: "src/api/index.ts",
      links: [
        { to: "db", role: "read-write" },
        { to: "jobs", role: "produce" },
      ],
    },
    jobs: { kind: "queue", resolution: "sqs-standard" },
    worker: {
      kind: "background-worker",
      resolution: "lambda-worker",
      entry: "src/worker/index.ts",
      links: [
        { to: "jobs", role: "consume" },
        { to: "db", role: "read-write" },
      ],
    },
    db: { kind: "relational-database", resolution: "rds-postgres" },
  },
  environments: { dev: {}, prod: { usage: { requestsPerMonth: 2000000, messagesPerMonth: 2000000 }, overrides: { db: { instanceClass: "db.t4g.small" }, worker: { maxConcurrency: 10 } } } },
};

const bundle = { code: "export const handler = async () => ({ statusCode: 200 });" };

function inputFor(environment: string, blueprint = sample): CompileInput {
  const merged = mergeEnvironment(blueprint, environment, deriveSizing);
  if (!merged) throw new Error(`no environment ${environment}`);
  const bundles = Object.fromEntries(Object.entries(blueprint.intents).filter(([, intent]) => "entry" in intent).map(([name]) => [name, bundle]));
  return { blueprint: merged, bundles };
}

// Runs the program under the mock runtime and returns what it declared.
async function run(input: CompileInput): Promise<{ declared: Declared[]; outputs: Record<string, unknown> }> {
  declared.length = 0;
  const result = await pulumi.runtime.runInPulumiStack(compileProgram(input));
  // Resources declared from resolved outputs register after the program
  // returns; the disconnect waits for every outstanding registration.
  await pulumi.runtime.disconnect();
  const outputs = await new Promise<Record<string, unknown>>((resolve) => {
    pulumi.output(result).apply((resolved) => resolve(resolved as Record<string, unknown>));
  });
  return { declared: [...declared], outputs };
}

const statementsOf = (policy: Declared) => (JSON.parse(policy.inputs.policy as string) as { Statement: unknown[] }).Statement;

const ofType = (type: string) => declared.filter((resource) => resource.type === type);
const only = (type: string) => {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  return found[0]!;
};

describe("the program for the sample blueprint merged for prod", () => {
  let outputs: Record<string, unknown>;

  beforeAll(async () => {
    ({ outputs } = await run(inputFor("prod")));
  });

  it("declares exactly the resources of the two resolutions and the link", () => {
    const types = declared.map((resource) => resource.type).filter((type) => type !== "pulumi:pulumi:Stack").sort();
    expect(types).toEqual(
      [
        "aws:apigatewayv2/api:Api",
        "aws:apigatewayv2/integration:Integration",
        "aws:apigatewayv2/route:Route",
        "aws:apigatewayv2/stage:Stage",
        "aws:cloudwatch/logGroup:LogGroup",
        "aws:ec2/securityGroup:SecurityGroup",
        "aws:ec2/securityGroup:SecurityGroup",
        "aws:ec2/securityGroupRule:SecurityGroupRule",
        "aws:iam/role:Role",
        "aws:iam/rolePolicy:RolePolicy",
        "aws:iam/rolePolicyAttachment:RolePolicyAttachment",
        "aws:lambda/function:Function",
        "aws:lambda/permission:Permission",
        "aws:rds/instance:Instance",
      ].sort(),
    );
    expect(ofType("aws:ec2/natGateway:NatGateway")).toEqual([]);
  });

  it("sizes the database from the merged blueprint, private, with the managed master password", () => {
    const { inputs } = only("aws:rds/instance:Instance");
    expect(inputs).toMatchObject({
      engine: "postgres",
      instanceClass: "db.t4g.large",
      allocatedStorage: 20,
      multiAz: false,
      publiclyAccessible: false,
      manageMasterUserPassword: true,
      dbName: "todos",
      vpcSecurityGroupIds: ["db-id"],
    });
    expect(inputs).not.toHaveProperty("password");
  });

  it("has exactly one ingress rule on the database group, from the API group, on the Postgres port", () => {
    const { inputs } = only("aws:ec2/securityGroupRule:SecurityGroupRule");
    expect(inputs).toMatchObject({
      type: "ingress",
      securityGroupId: "db-id",
      sourceSecurityGroupId: "api-id",
      fromPort: 5432,
      toPort: 5432,
      protocol: "tcp",
    });
    expect(ofType("aws:ec2/securityGroup:SecurityGroup").map((group) => group.name).sort()).toEqual(["api", "db"]);
    for (const group of ofType("aws:ec2/securityGroup:SecurityGroup")) {
      expect(group.inputs, group.name).toMatchObject({ vpcId: "vpc-1" });
      expect(group.inputs.ingress ?? []).toEqual([]);
    }
  });

  it("gives the Lambda the sizing, the VPC attachment, the bundle and the link's environment variables", () => {
    const { inputs } = only("aws:lambda/function:Function");
    expect(inputs).toMatchObject({
      runtime: "nodejs22.x",
      handler: "index.handler",
      memorySize: 1024,
      timeout: 10,
      role: "arn:api",
      vpcConfig: { subnetIds: ["subnet-a", "subnet-b"], securityGroupIds: ["api-id"] },
      environment: {
        variables: {
          HULL_DB_HOST: "db.internal",
          HULL_DB_PORT: "5432",
          HULL_DB_NAME: "todos",
          HULL_DB_USER: "postgres",
          HULL_DB_PASSWORD_ARN: secretArn,
        },
      },
    });
    expect(Object.keys((inputs.environment as { variables: object }).variables)).toHaveLength(5);
  });

  it("lets the Lambda's role reach the VPC and read only the database secret", () => {
    const { inputs: attachment } = only("aws:iam/rolePolicyAttachment:RolePolicyAttachment");
    expect(attachment).toMatchObject({
      role: "api",
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
    });
    const { inputs: policy } = only("aws:iam/rolePolicy:RolePolicy");
    expect(policy.role).toBe("api");
    expect(JSON.parse(policy.policy as string)).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn }],
    });
  });

  it("routes every request of an HTTP API to the Lambda and outputs the URL", () => {
    expect(only("aws:apigatewayv2/api:Api").inputs).toMatchObject({ protocolType: "HTTP" });
    expect(only("aws:apigatewayv2/integration:Integration").inputs).toMatchObject({
      integrationType: "AWS_PROXY",
      integrationUri: "invoke:api",
      payloadFormatVersion: "2.0",
    });
    expect(only("aws:apigatewayv2/route:Route").inputs).toMatchObject({ routeKey: "$default", target: "integrations/api-id" });
    expect(only("aws:apigatewayv2/stage:Stage").inputs).toMatchObject({ name: "$default", autoDeploy: true });
    expect(only("aws:lambda/permission:Permission").inputs).toMatchObject({
      action: "lambda:InvokeFunction",
      principal: "apigateway.amazonaws.com",
      function: "api",
      sourceArn: "arn:aws:execute-api:us-east-1:123456789012:abc/*/*",
    });
    expect(outputs).toEqual({ apiUrl: "https://abc.execute-api.us-east-1.amazonaws.com" });
  });
});

describe("the program for the demo blueprint merged for dev", () => {
  let all: Declared[];
  const named = (type: string, name: string) => {
    const found = all.filter((resource) => resource.type === type && resource.name === name);
    expect(found, `${type} ${name}`).toHaveLength(1);
    return found[0]!;
  };

  beforeAll(async () => {
    ({ declared: all } = await run(inputFor("dev", demo)));
  });

  it("declares the queue, its dead-letter queue, the worker Lambda and the event source mapping, and no NAT gateway", () => {
    const types = all.map((resource) => resource.type).filter((type) => type !== "pulumi:pulumi:Stack").sort();
    expect(types).toEqual(
      [
        "aws:apigatewayv2/api:Api",
        "aws:apigatewayv2/integration:Integration",
        "aws:apigatewayv2/route:Route",
        "aws:apigatewayv2/stage:Stage",
        "aws:cloudwatch/logGroup:LogGroup",
        "aws:cloudwatch/logGroup:LogGroup",
        "aws:ec2/securityGroup:SecurityGroup",
        "aws:ec2/securityGroup:SecurityGroup",
        "aws:ec2/securityGroup:SecurityGroup",
        "aws:ec2/securityGroupRule:SecurityGroupRule",
        "aws:ec2/securityGroupRule:SecurityGroupRule",
        "aws:iam/role:Role",
        "aws:iam/role:Role",
        "aws:iam/rolePolicy:RolePolicy",
        "aws:iam/rolePolicy:RolePolicy",
        "aws:iam/rolePolicy:RolePolicy",
        "aws:iam/rolePolicy:RolePolicy",
        "aws:iam/rolePolicyAttachment:RolePolicyAttachment",
        "aws:iam/rolePolicyAttachment:RolePolicyAttachment",
        "aws:lambda/eventSourceMapping:EventSourceMapping",
        "aws:lambda/function:Function",
        "aws:lambda/function:Function",
        "aws:lambda/permission:Permission",
        "aws:rds/instance:Instance",
        "aws:sqs/queue:Queue",
        "aws:sqs/queue:Queue",
      ].sort(),
    );
    expect(all.filter((resource) => resource.type === "aws:ec2/natGateway:NatGateway")).toEqual([]);
  });

  it("sizes the queue as merged and redrives to a dead-letter queue after five receives, kept fourteen days", () => {
    const deadLetter = named("aws:sqs/queue:Queue", "jobs-dead-letter");
    expect(deadLetter.inputs).toMatchObject({ messageRetentionSeconds: 14 * 24 * 3600 });
    expect(deadLetter.inputs).not.toHaveProperty("redrivePolicy");
    const queue = named("aws:sqs/queue:Queue", "jobs");
    expect(queue.inputs).toMatchObject({ visibilityTimeoutSeconds: 60, messageRetentionSeconds: 4 * 24 * 3600 });
    expect(JSON.parse(queue.inputs.redrivePolicy as string)).toEqual({ deadLetterTargetArn: "arn:jobs-dead-letter", maxReceiveCount: 5 });
  });

  it("feeds the worker from the queue with the sizing's batch size and concurrency, reporting batch item failures", () => {
    const worker = named("aws:lambda/function:Function", "worker");
    expect(worker.inputs).toMatchObject({ runtime: "nodejs22.x", handler: "index.handler", memorySize: 512, timeout: 30, role: "arn:worker" });
    const mapping = named("aws:lambda/eventSourceMapping:EventSourceMapping", "worker-jobs");
    expect(mapping.inputs).toMatchObject({
      eventSourceArn: "arn:jobs",
      functionName: "worker",
      batchSize: 10,
      scalingConfig: { maximumConcurrency: 2 },
      functionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("gives the API's role exactly one statement on the queue, to send, beside the secret read", () => {
    expect(statementsOf(named("aws:iam/rolePolicy:RolePolicy", "api-jobs"))).toEqual([
      { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: "arn:jobs" },
    ]);
    expect(statementsOf(named("aws:iam/rolePolicy:RolePolicy", "api-db"))).toEqual([
      { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn },
    ]);
  });

  it("gives the worker's role exactly one statement on the queue, to receive, delete and read attributes, beside the secret read", () => {
    expect(statementsOf(named("aws:iam/rolePolicy:RolePolicy", "worker-jobs"))).toEqual([
      { Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource: "arn:jobs" },
    ]);
    expect(statementsOf(named("aws:iam/rolePolicy:RolePolicy", "worker-db"))).toEqual([
      { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn },
    ]);
    expect(all.filter((resource) => resource.type === "aws:iam/rolePolicy:RolePolicy").map((policy) => policy.name).sort()).toEqual(["api-db", "api-jobs", "worker-db", "worker-jobs"]);
  });

  it("hands each tier exactly its links' contract as environment variables", () => {
    const queueContract = { HULL_JOBS_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/jobs", HULL_JOBS_ARN: "arn:jobs" };
    const databaseContract = { HULL_DB_HOST: "db.internal", HULL_DB_PORT: "5432", HULL_DB_NAME: "todos", HULL_DB_USER: "postgres", HULL_DB_PASSWORD_ARN: secretArn };
    const variablesOf = (name: string) => (named("aws:lambda/function:Function", name).inputs.environment as { variables: object }).variables;
    expect(variablesOf("api")).toEqual({ ...databaseContract, ...queueContract });
    expect(variablesOf("worker")).toEqual({ ...queueContract, ...databaseContract });
  });

  it("attaches the worker to the VPC because it links the database, like the API", () => {
    expect(named("aws:lambda/function:Function", "worker").inputs).toMatchObject({
      vpcConfig: { subnetIds: ["subnet-a", "subnet-b"], securityGroupIds: ["worker-id"] },
    });
    expect(named("aws:ec2/securityGroupRule:SecurityGroupRule", "worker-db").inputs).toMatchObject({ securityGroupId: "db-id", sourceSecurityGroupId: "worker-id", fromPort: 5432 });
    expect(named("aws:iam/rolePolicyAttachment:RolePolicyAttachment", "worker").inputs).toMatchObject({
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
    });
  });

  // What this deploys (#26): every Pulumi type the program declares for an
  // intent maps to one of the resources its resolution declares in the
  // catalog, and every catalog resource is declared. Link resources belong
  // to the tier that holds the link.
  it("declares, per deployable resolution, exactly the resources the catalog names", () => {
    const typesByResource: Record<string, string[]> = {
      "Lambda function": ["aws:lambda/function:Function"],
      "log group": ["aws:cloudwatch/logGroup:LogGroup"],
      "execution role": ["aws:iam/role:Role", "aws:iam/rolePolicy:RolePolicy", "aws:iam/rolePolicyAttachment:RolePolicyAttachment"],
      "security group": ["aws:ec2/securityGroup:SecurityGroup", "aws:ec2/securityGroupRule:SecurityGroupRule"],
      "HTTP API": ["aws:apigatewayv2/api:Api", "aws:apigatewayv2/integration:Integration", "aws:apigatewayv2/route:Route", "aws:apigatewayv2/stage:Stage", "aws:lambda/permission:Permission"],
      "event source mapping": ["aws:lambda/eventSourceMapping:EventSourceMapping"],
      "RDS instance": ["aws:rds/instance:Instance"],
      "gp3 storage": ["aws:rds/instance:Instance"],
      "managed master password secret": ["aws:rds/instance:Instance"],
      "SQS queue": ["aws:sqs/queue:Queue"],
      "dead-letter queue": ["aws:sqs/queue:Queue"],
    };
    const resourceOfType = (type: string) => Object.entries(typesByResource).filter(([, types]) => types.includes(type)).map(([resource]) => resource);

    for (const [intent, { resolution }] of Object.entries(demo.intents)) {
      const own = all.filter((resource) => resource.name === intent || resource.name.startsWith(`${intent}-`));
      const declaredResources = new Set(own.flatMap((resource) => resourceOfType(resource.type)));
      const catalogResources = resources[resolution as keyof typeof resources];
      // Both queues share one type: the dead-letter queue is told apart by name.
      if (resolution === "sqs-standard") expect(own.map((resource) => resource.name).sort()).toEqual(["jobs", "jobs-dead-letter"]);
      expect([...declaredResources].sort(), `${intent} (${resolution})`).toEqual([...catalogResources].sort());
      for (const resource of own) expect(resourceOfType(resource.type), `${resource.type} of ${intent}`).not.toEqual([]);
    }
  });
});

describe("the program for a worker linked only to a queue", () => {
  it("keeps the worker outside the VPC, with the basic execution policy and no security group", async () => {
    const queueOnly: Blueprint = {
      ...demo,
      intents: { ...demo.intents, worker: { ...demo.intents.worker!, links: [{ to: "jobs", role: "consume" }] } as Blueprint["intents"][string] },
    };

    const { declared: all } = await run(inputFor("dev", queueOnly));

    const worker = all.find((resource) => resource.type === "aws:lambda/function:Function" && resource.name === "worker")!;
    expect(worker.inputs).not.toHaveProperty("vpcConfig");
    expect(all.filter((resource) => resource.type === "aws:ec2/securityGroup:SecurityGroup").map((group) => group.name).sort()).toEqual(["api", "db"]);
    expect(all.find((resource) => resource.type === "aws:iam/rolePolicyAttachment:RolePolicyAttachment" && resource.name === "worker")!.inputs).toMatchObject({
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });
    expect(all.filter((resource) => resource.type === "aws:iam/rolePolicy:RolePolicy" && resource.name.startsWith("worker")).map((policy) => policy.name)).toEqual(["worker-jobs"]);
  });

  it("compiles a queue nobody consumes, without an event source mapping", async () => {
    const unconsumed: Blueprint = {
      ...demo,
      intents: { ...demo.intents, worker: { ...demo.intents.worker!, links: [{ to: "db", role: "read-write" }] } as Blueprint["intents"][string] },
    };

    const { declared: all } = await run(inputFor("dev", unconsumed));

    expect(all.filter((resource) => resource.type === "aws:lambda/eventSourceMapping:EventSourceMapping")).toEqual([]);
    expect(all.filter((resource) => resource.type === "aws:sqs/queue:Queue").map((queue) => queue.name).sort()).toEqual(["jobs", "jobs-dead-letter"]);
  });
});

describe("compileProgram refusals", () => {
  it("refuses the Fargate resolutions as not deployable in this version", () => {
    const input = inputFor("dev");
    input.blueprint.intents.api!.resolution = "fargate-load-balancer";

    expect(() => compileProgram(input)).toThrow(
      new CompileError('intent "api" resolves to fargate-load-balancer, which is not deployable in this version'),
    );

    const worker = inputFor("dev", demo);
    worker.blueprint.intents.worker!.resolution = "fargate-worker";
    expect(() => compileProgram(worker)).toThrow(
      new CompileError('intent "worker" resolves to fargate-worker, which is not deployable in this version'),
    );
  });

  it("refuses a second http-api intent", () => {
    const input = inputFor("dev", {
      ...sample,
      intents: { ...sample.intents, admin: { kind: "http-api", resolution: "lambda-api-gateway", entry: "src/admin.ts" } },
    });
    input.bundles.admin = bundle;

    expect(() => compileProgram(input)).toThrow(
      new CompileError("this version deploys one http-api intent; the blueprint has api, admin"),
    );
  });

  it("refuses a sizing override the resolution cannot take", () => {
    const input = inputFor("dev");
    input.blueprint.intents.db!.sizing.storageGb = { value: 2.5, source: "overridden" };

    expect(() => compileProgram(input)).toThrow(
      new CompileError('intent "db" has an invalid sizing: storageGb Invalid input: expected int, received number'),
    );
  });

  it("refuses an intent without its bundle", () => {
    const input = inputFor("dev");
    input.bundles = {};

    expect(() => compileProgram(input)).toThrow(new CompileError('no bundle for intent "api"'));

    const worker = inputFor("dev", demo);
    delete worker.bundles.worker;
    expect(() => compileProgram(worker)).toThrow(new CompileError('no bundle for intent "worker"'));
  });
});
