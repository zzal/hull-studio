// The blueprint `hull init` writes: the milestone 1 plan's sample in the
// canonical form of the `yaml` Document API, so later studio edits on a
// Hull-created file never produce formatting noise. The two comment lines
// are what JetBrains and the YAML language server read to find the schema.
export function sampleBlueprint(schemaUrl: string): string {
  return `# $schema: ${schemaUrl}
# yaml-language-server: $schema=${schemaUrl}

name: todos
provider: aws
region: us-east-1

usage:
  # usage profile, low-end defaults from \`hull init\`
  requestsPerMonth: 100000
  storageGb: 1

intents:
  api:
    kind: http-api
    resolution: lambda-api-gateway
    entry: src/api/index.ts
    links:
      - to: db
        role: read-write

  db:
    kind: relational-database
    resolution: rds-postgres

environments:
  dev: {}
  prod:
    usage:
      requestsPerMonth: 2000000
    overrides:
      db:
        instanceClass: db.t4g.small
`;
}
