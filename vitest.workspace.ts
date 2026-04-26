import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: [
        "tests/tools/**/*.test.ts",
        "tests/formatters/**/*.test.ts",
        "tests/oura/**/*.test.ts",
        "tests/utils/**/*.test.ts",
        "tests/obsidian/**/*.test.ts",
        "tests/ingest/**/*.test.ts",
      ],
      exclude: ["tests/integration/**"],
    },
  },
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      globalSetup: ["tests/setup/global-setup.ts"],
      setupFiles: ["tests/setup/per-test-setup.ts"],
      // Tests share a single test DB and `beforeEach` truncates+re-seeds the
      // whole schema. Run all integration files in a single fork so beforeEach
      // executions serialize on one Postgres connection pool (eliminates
      // duplicate-key + FK violations from concurrent seeders).
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      env: {
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@localhost:5433/journal_test",
      },
    },
  },
]);
