import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getLatestObsidianSyncRun, getObsidianSyncCounts } from "../db/queries.js";

export async function handleGetObsidianSyncStatus(pool: pg.Pool, input: unknown): Promise<string> {
  validateToolInput("get_obsidian_sync_status", input);
  const [lastRun, counts] = await Promise.all([
    getLatestObsidianSyncRun(pool),
    getObsidianSyncCounts(pool),
  ]);
  return JSON.stringify({
    last_run: lastRun ? {
      started_at: lastRun.started_at,
      finished_at: lastRun.finished_at,
      status: lastRun.status,
      files_synced: lastRun.files_synced,
      files_deleted: lastRun.files_deleted,
      links_resolved: lastRun.links_resolved,
      errors: lastRun.errors,
    } : null,
    total_obsidian_artifacts: counts.total,
    pending_embeddings: counts.pendingEmbeddings,
  }, null, 2);
}
