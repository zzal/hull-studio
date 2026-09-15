import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The dashboard: built into dist/client, which the studio server serves as
// static files. `pnpm dev` runs it against a studio started separately with
// `hull studio --port 4800`.
const studio = "http://127.0.0.1:4800";

export default defineConfig({
  root: "client",
  plugins: [react()],
  // Workspace packages resolve to their TypeScript source, never to dist.
  resolve: { conditions: ["@hull/source", ...defaultClientConditions] },
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    proxy: {
      "/blueprint": studio,
      "/templates": studio,
      "/catalog": studio,
      "/estimate": studio,
      "/recommendations": studio,
      "/operations": studio,
      "/changes": { target: studio, ws: true },
    },
  },
});
