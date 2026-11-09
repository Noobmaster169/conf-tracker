import { defineConfig } from "vitest/config";

/** Pure helpers only. Rendering is checked by looking at the page. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ["{app,components,lib}/**/*.test.ts"], environment: "node" },
});
