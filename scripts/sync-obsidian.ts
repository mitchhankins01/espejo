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

// Wait for review-extraction to finish before closing the pool, then strip the
// promise from the printed result.
if (result?.extractionPromise) {
  await result.extractionPromise;
}
const { extractionPromise: _drop, ...printable } = result ?? {};
void _drop;
console.log(JSON.stringify(printable, null, 2));

await pool.end();
