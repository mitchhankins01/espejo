import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}
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

interface Migration {
  name: string;
  getSql: () => string;
}

const migrations: Migration[] = [
  {
    name: "001-initial-schema",
    getSql: () =>
      fs.readFileSync(
        path.resolve(__dirname, "..", "specs", "schema.sql"),
        "utf-8"
      ),
  },
  {
    name: "002-daily-metrics",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS daily_metrics (
          id SERIAL PRIMARY KEY,
          date DATE UNIQUE NOT NULL,
          weight_kg DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
    `,
  },
];

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

    for (const migration of migrations) {
      // Check if already applied
      const existing = await pool.query(
        "SELECT id FROM _migrations WHERE name = $1",
        [migration.name]
      );

      if (existing.rows.length > 0) {
        console.log(`Migration "${migration.name}" already applied, skipping.`);
        continue;
      }

      // Read and apply schema
      const sql = migration.getSql();

      await pool.query("BEGIN");
      try {
        const statements = splitSqlStatements(sql);
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (trimmed && !trimmed.startsWith("--")) {
            await pool.query(trimmed);
          }
        }

        // Record migration
        await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [
          migration.name,
        ]);

        await pool.query("COMMIT");
        console.log(`Applied migration: ${migration.name}`);
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
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
