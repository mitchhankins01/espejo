import os from "os";
import { pool } from "../src/db/client.js";
import { logUsage } from "../src/db/queries/usage.js";
import { runOuraSync } from "../src/oura/sync.js";

async function main(): Promise<void> {
  const daysArgIndex = process.argv.indexOf("--days");
  const days = daysArgIndex > -1 ? Number.parseInt(process.argv[daysArgIndex + 1] ?? "30", 10) : 30;
  const lookback = Number.isFinite(days) ? days : 30;
  const startedAt = Date.now();
  try {
    const result = await runOuraSync(pool, lookback);
    logUsage(pool, {
      source: "script",
      surface: "oura-sync",
      actor: os.hostname(),
      action: "sync-oura",
      args: { days: lookback },
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: result ?? { skipped: true },
    });
    console.log(`Oura sync completed for lookback ${lookback} days.`);
  } catch (err) {
    logUsage(pool, {
      source: "script",
      surface: "oura-sync",
      actor: os.hostname(),
      action: "sync-oura",
      args: { days: lookback },
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error("Oura sync failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
