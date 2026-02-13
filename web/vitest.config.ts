import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "$lib": "/src/lib",
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
