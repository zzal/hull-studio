import type { Vocabulary } from "@hull/blueprint";

// Catalog v0 vocabulary: the two intent kinds and three resolutions of the
// milestone 1 plan, with their sizing parameters and roles. Sizing, estimate
// and recommendation rules land with the sizing ticket.
export const vocabulary: Vocabulary = {
  kinds: {
    "http-api": { roles: [] },
    "relational-database": { roles: ["read-write"] },
  },
  resolutions: {
    "lambda-api-gateway": {
      provider: "aws",
      kind: "http-api",
      sizingParameters: ["memoryMb", "timeoutSeconds"],
    },
    "fargate-load-balancer": {
      provider: "aws",
      kind: "http-api",
      sizingParameters: ["cpu", "memoryMb", "desiredCount"],
    },
    "rds-postgres": {
      provider: "aws",
      kind: "relational-database",
      sizingParameters: ["instanceClass", "storageGb", "multiAz"],
    },
  },
};
