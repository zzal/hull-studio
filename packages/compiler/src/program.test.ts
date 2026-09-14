import { mergeEnvironment, type Blueprint } from "@hull/blueprint";
import { deriveSizing } from "@hull/catalog";
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

const bundle = { code: "export const handler = async () => ({ statusCode: 200 });" };

function inputFor(environment: string, blueprint = sample): CompileInput {
  const merged = mergeEnvironment(blueprint, environment, deriveSizing);
  if (!merged) throw new Error(`no environment ${environment}`);
  return { blueprint: merged, bundles: { api: bundle } };
}

const ofType = (type: string) => declared.filter((resource) => resource.type === type);
const only = (type: string) => {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  return found[0]!;
};

describe("the program for the sample blueprint merged for prod", () => {
  let outputs: Record<string, unknown>;

  beforeAll(async () => {
    declared.length = 0;
    const result = await pulumi.runtime.runInPulumiStack(compileProgram(inputFor("prod")));
    // Resources declared from resolved outputs register after the program
    // returns; the disconnect waits for every outstanding registration.
    await pulumi.runtime.disconnect();
    outputs = await new Promise<Record<string, unknown>>((resolve) => {
      pulumi.output(result).apply((resolved) => resolve(resolved as Record<string, unknown>));
    });
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

describe("compileProgram refusals", () => {
  it("refuses the Fargate resolution as not deployable in this version", () => {
    const input = inputFor("dev");
    input.blueprint.intents.api!.resolution = "fargate-load-balancer";

    expect(() => compileProgram(input)).toThrow(
      new CompileError('intent "api" resolves to fargate-load-balancer, which is not deployable in this version'),
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
  });
});
