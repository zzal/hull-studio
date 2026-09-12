# YAML blueprint instead of a TypeScript config

The blueprint is YAML with a published JSON Schema, not a TypeScript config file as SST and Pulumi use. The studio must round-trip the file without destroying hand edits and comments, which a comment-preserving YAML parser does and a program cannot. Completion and validation come from the schema in both JetBrains and VS Code, so the TypeScript authoring advantage does not apply.

## Considered Options

- TypeScript config (`hull.config.ts`): a program can compute values, which breaks the static estimate, and cannot be safely rewritten by the studio.
- Constrained TypeScript object literal, round-tripped with the compiler API: looks like code while forbidding imports, spreads, and computed values; the studio would have to refuse to save until logic is removed.
- JSON: no comments; hostile to a beginner's first read.
