import { execSync } from "child_process";

export async function setup(): Promise<void> {
  console.log("Starting test database...");
  execSync("docker compose -f docker-compose.test.yml up -d --wait", {
    stdio: "inherit",
  });

  execSync("pnpm migrate", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://test:test@localhost:5433/journal_test",
      NODE_ENV: "test",
    },
  });
}

export async function teardown(): Promise<void> {
  console.log("Stopping test database...");
  execSync("docker compose -f docker-compose.test.yml down -v", {
    stdio: "inherit",
  });
}
