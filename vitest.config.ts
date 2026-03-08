import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/db/client.ts", "src/transports/oauth.ts", "src/oura/types.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        // Global baseline: high signal without forcing low-value edge-case tests everywhere.
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
        // Keep strict 100% on core modules where regressions are costly.
        "src/db/queries.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/transports/http.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/tools/search.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/oura/analysis.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
});
