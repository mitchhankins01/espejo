import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}
import fs from "fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "test"
    ? "postgresql://test:test@localhost:5433/journal_test"
    : "postgresql://dev:dev@localhost:5434/journal_dev");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function getFilePath(): string {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error("Usage: pnpm sync:weight -- --file /path/to/weight-export.json");
    process.exit(1);
  }
  return args[fileIdx + 1];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeightEntry {
  date: string; // "2026-02-21 00:00:00 -0500"
  qty: number; // kg
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function syncWeight(): Promise<void> {
  const filePath = getFilePath();

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);

  // Support both formats:
  // 1. Flat array: [{date, qty}, ...]
  // 2. Health Auto Export nested: {data: {metrics: [{data: [{date, qty}, ...]}]}}
  let entries: WeightEntry[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed?.data?.metrics?.[0]?.data) {
    entries = parsed.data.metrics[0].data;
    const name = parsed.data.metrics[0].name || "unknown";
    const units = parsed.data.metrics[0].units || "unknown";
    console.log(`Detected Health Auto Export format: ${name} (${units})`);
  } else {
    console.error("Unrecognized JSON format. Expected a flat array or Health Auto Export structure.");
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log("No weight entries found in file.");
    return;
  }

  console.log(`Found ${entries.length} weight entries in ${filePath}`);

  // Parse dates and weights
  const rows: { date: string; weightKg: number }[] = [];
  for (const entry of entries) {
    const date = entry.date.slice(0, 10); // "YYYY-MM-DD"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.warn(`Skipping invalid date: ${entry.date}`);
      continue;
    }
    if (typeof entry.qty !== "number" || entry.qty <= 0) {
      console.warn(`Skipping invalid weight for ${date}: ${entry.qty}`);
      continue;
    }
    rows.push({ date, weightKg: entry.qty });
  }

  console.log(`Parsed ${rows.length} valid entries`);

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const start = Date.now();

  try {
    const BATCH_SIZE = 100;
    let upserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const dates = batch.map((r) => r.date);
      const weights = batch.map((r) => r.weightKg);

      await pool.query(
        `INSERT INTO daily_metrics (date, weight_kg)
         SELECT d_date, d_weight
         FROM unnest($1::date[], $2::float8[]) AS d(d_date, d_weight)
         ON CONFLICT (date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg`,
        [dates, weights]
      );

      upserted += batch.length;
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: upserted ${batch.length} rows (${upserted}/${rows.length})`);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Done. Upserted ${upserted} weight entries in ${elapsed}s.`);
  } finally {
    await pool.end();
  }
}

syncWeight().catch((err) => {
  console.error("Weight sync failed:", err);
  process.exit(1);
});
