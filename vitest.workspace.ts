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
      env: {
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@localhost:5433/journal_test",
      },
    },
  },
]);
