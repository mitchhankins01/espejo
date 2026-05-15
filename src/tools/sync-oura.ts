import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { runOuraSync } from "../oura/sync.js";

export async function handleSyncOura(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("sync_oura", input);
  const result = await runOuraSync(pool, params.lookback_days);
  if (!result) {
    return "Oura sync skipped (OURA_ACCESS_TOKEN not configured or another sync is holding the advisory lock).";
  }
  return JSON.stringify(
    {
      run_id: result.runId,
      total: result.total,
      counts: result.counts,
      duration_ms: result.durationMs,
    },
    null,
    2
  );
}
