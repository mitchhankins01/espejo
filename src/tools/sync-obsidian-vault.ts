import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { runObsidianSync } from "../obsidian/sync.js";

export async function handleSyncObsidianVault(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("sync_obsidian_vault", input);
  // Note: file_path param is reserved for future single-file sync
  void params;
  const result = await runObsidianSync(pool);
  if (!result) return "Obsidian sync skipped (R2 not configured or lock busy).";
  return JSON.stringify({
    files_synced: result.filesSynced,
    files_deleted: result.filesDeleted,
    links_resolved: result.linksResolved,
    errors: result.errors,
    duration_ms: result.durationMs,
  }, null, 2);
}
