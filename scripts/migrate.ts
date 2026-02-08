import dotenv from "dotenv";
dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "test"
    ? "postgresql://test:test@localhost:5433/journal_test"
    : "postgresql://dev:dev@localhost:5434/journal_dev");

async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Ensure _migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const schemaPath = path.resolve(__dirname, "..", "specs", "schema.sql");
    const migrationName = "001-initial-schema";

    // Check if already applied
    const existing = await pool.query(
      "SELECT id FROM _migrations WHERE name = $1",
      [migrationName]
    );

    if (existing.rows.length > 0) {
      console.log(`Migration "${migrationName}" already applied, skipping.`);
      return;
    }

    // Read and apply schema
    const sql = fs.readFileSync(schemaPath, "utf-8");

    // Split on semicolons but handle the GENERATED ALWAYS AS clause and other complex statements
    // Execute the whole file as a single transaction
    await pool.query("BEGIN");
    try {
      // Execute statements one by one, splitting carefully
      const statements = splitSqlStatements(sql);
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed && !trimmed.startsWith("--")) {
          await pool.query(trimmed);
        }
      }

      // Record migration
      await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [
        migrationName,
      ]);

      await pool.query("COMMIT");
      console.log(`Applied migration: ${migrationName}`);
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  } finally {
    await pool.end();
  }
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inParens = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "(") inParens++;
    if (char === ")") inParens--;

    if (char === ";" && inParens === 0) {
      statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements.filter((s) => s.length > 0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
