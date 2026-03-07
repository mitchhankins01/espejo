import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Run serially — tests share a real dev database
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "light",
      use: { colorScheme: "light" },
    },
    {
      name: "dark",
      use: { colorScheme: "dark" },
    },
  ],
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
