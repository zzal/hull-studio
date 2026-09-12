import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Declarations come from tsc (TypeScript 7 has no JS API for tsup's dts step).
  dts: false,
  sourcemap: true,
  clean: true,
});
