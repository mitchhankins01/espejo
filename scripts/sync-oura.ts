import { pool } from "../src/db/client.js";
import { runOuraSync } from "../src/oura/sync.js";

async function main(): Promise<void> {
  const daysArgIndex = process.argv.indexOf("--days");
  const days = daysArgIndex > -1 ? Number.parseInt(process.argv[daysArgIndex + 1] ?? "30", 10) : 30;
  await runOuraSync(pool, Number.isFinite(days) ? days : 30);
  console.log(`Oura sync completed for lookback ${days} days.`);
}

main()
  .catch((err) => {
    console.error("Oura sync failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
