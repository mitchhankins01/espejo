import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: [
        "tests/tools/**/*.test.ts",
        "tests/formatters/**/*.test.ts",
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
    },
  },
]);
