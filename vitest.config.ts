import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages expose their TypeScript source under the `@hull/source`
// export condition so tests and typechecks never need a prior build.
const sourceCondition = "@hull/source";

export default defineConfig({
  resolve: {
    conditions: [sourceCondition, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      // Without "module": Pulumi's SDK depends on @opentelemetry/api, whose
      // "module" build imports without extensions and cannot run in Node.
      conditions: [sourceCondition, ...defaultServerConditions.filter((condition) => condition !== "module")],
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
