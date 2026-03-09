import { execSync } from "child_process";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://test:test@localhost:5432/journal_test";

function isDockerAvailable(): boolean {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isLocalPgReady(): boolean {
  try {
    execSync(`pg_isready -h localhost -p 5432`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureLocalTestDb(): void {
  // Create user, database, and extensions via the postgres superuser
  // These are idempotent — safe to re-run
  const cmds = [
    `sudo -u postgres psql -c "SELECT 1 FROM pg_roles WHERE rolname='test'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER test WITH PASSWORD 'test' CREATEDB;"`,
    `sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='journal_test'" | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE journal_test OWNER test;"`,
    `sudo -u postgres psql -d journal_test -c "CREATE EXTENSION IF NOT EXISTS vector;"`,
    `sudo -u postgres psql -d journal_test -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"`,
    `sudo -u postgres psql -d journal_test -c "GRANT ALL ON SCHEMA public TO test;"`,
  ];
  for (const cmd of cmds) {
    execSync(cmd, { stdio: "inherit" });
  }
}

let useDocker = false;

export async function setup(): Promise<void> {
  if (isLocalPgReady()) {
    console.log("Using local PostgreSQL for tests...");
    ensureLocalTestDb();
    useDocker = false;
  } else if (isDockerAvailable()) {
    console.log("Starting test database via Docker...");
    execSync(
      "docker compose -p espejo-test -f docker-compose.test.yml up -d --wait",
      { stdio: "inherit" },
    );
    useDocker = true;
  } else {
    throw new Error(
      "No database available: local PostgreSQL is not running and Docker is not available.",
    );
  }

  execSync("pnpm migrate", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL,
      NODE_ENV: "test",
    },
  });
}

export async function teardown(): Promise<void> {
  if (useDocker) {
    console.log("Stopping test database...");
    execSync(
      "docker compose -p espejo-test -f docker-compose.test.yml down -v",
      { stdio: "inherit" },
    );
  }
}
