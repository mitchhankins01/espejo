import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

import pg from "pg";
import { runObsidianSync } from "../src/obsidian/sync.js";

const databaseUrl =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "test"
    ? "postgresql://test:test@localhost:5433/journal_test"
    : "postgresql://dev:dev@localhost:5434/journal_dev");

const pool = new pg.Pool({ connectionString: databaseUrl });

const result = await runObsidianSync(pool);
console.log(JSON.stringify(result, null, 2));

await pool.end();
