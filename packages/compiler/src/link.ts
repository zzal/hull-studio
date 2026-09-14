// The environment variable contract of a database link (milestone 1, "Compiler
// and deploy"): what the compiler sets on the tier and what the binding
// module reads, from one table. Intent names are lower-case letters, digits
// and underscores, so upper-cased they are valid variable names.
export function databaseLinkVariables(intent: string) {
  const prefix = `HULL_${intent.toUpperCase()}_`;
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
