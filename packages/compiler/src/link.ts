// The environment variable contract of a link (milestone 1 and 2, "Compiler
// and deploy"): what the compiler sets on the tier and what the binding
// module reads, from one table per target kind. Intent names are lower-case
// letters, digits and underscores, so upper-cased they are valid variable
// names.

const prefixOf = (intent: string) => `HULL_${intent.toUpperCase()}_`;

export function databaseLinkVariables(intent: string) {
  const prefix = prefixOf(intent);
  return {
    host: `${prefix}HOST`,
    port: `${prefix}PORT`,
    name: `${prefix}NAME`,
    user: `${prefix}USER`,
    // Secrets Manager ARN of the managed master password.
    passwordArn: `${prefix}PASSWORD_ARN`,
  };
}
export type DatabaseLinkVariables = ReturnType<typeof databaseLinkVariables>;

// A queue link, whatever its role: the queue's URL, which the SDK sends to,
// and its ARN.
export function queueLinkVariables(intent: string) {
  const prefix = prefixOf(intent);
  return { url: `${prefix}URL`, arn: `${prefix}ARN` };
}
export type QueueLinkVariables = ReturnType<typeof queueLinkVariables>;
