import type pg from "pg";

import { config } from "../config.js";
import {
  insertObsidianSyncRun,
  completeObsidianSyncRun,
  getObsidianArtifacts,
  upsertObsidianArtifact,
  softDeleteMissingObsidianArtifacts,
} from "../db/queries.js";
import {
  syncExplicitLinks,
} from "../db/queries/artifacts.js";
import { logUsage } from "../db/queries/usage.js";
import { createClient, listAllObjects, getObjectContent } from "../storage/r2.js";
import { notifyError } from "../telegram/notify.js";
import { parseObsidianNote } from "./parser.js";

// ============================================================================
// Constants
// ============================================================================

const LOCK_KEY = 9152202;
const VAULT_BUCKET = "artifacts";
const MAX_NOTE_BYTES = 1_048_576; // 1MB
const SYNC_INTERVAL_MS = 30 * 60_000; // 30 minutes
const DOWNLOAD_CONCURRENCY = 10;

/** Folders/prefixes to skip during sync */
const SKIP_PREFIXES = [".obsidian/", ".trash/", "Templates/"];

/** Only sync markdown files */
function isSyncableFile(key: string): boolean {
  if (!key.endsWith(".md")) return false;
  return !SKIP_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ============================================================================
// Sync result
// ============================================================================

export interface ObsidianSyncResult {
  runId: string;
  filesSynced: number;
  filesDeleted: number;
  linksResolved: number;
  errors: Array<{ file: string; error: string }>;
  durationMs: number;
}

// ============================================================================
// Core sync
// ============================================================================

export async function runObsidianSync(
  pool: pg.Pool
): Promise<ObsidianSyncResult | null> {
  if (!config.r2.accountId || !config.r2.accessKeyId) return null;

  const lock = await pool.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [LOCK_KEY]
  );
  if (!lock.rows[0]?.ok) return null;

  const runId = await insertObsidianSyncRun(pool);
  const t0 = Date.now();
  const errors: Array<{ file: string; error: string }> = [];
  let filesSynced = 0;
  let filesDeleted = 0;
  let linksResolved = 0;

  try {
    const r2Client = createClient();

    // 1. List all objects in vault bucket
    const allObjects = await listAllObjects(r2Client, VAULT_BUCKET);

    // 2. Filter to syncable .md files within size limit
    const mdFiles = allObjects.filter((obj) => {
      if (!isSyncableFile(obj.key)) return false;
      if (obj.size > MAX_NOTE_BYTES) {
        errors.push({ file: obj.key, error: `Skipped: ${obj.size} bytes exceeds 1MB limit` });
        return false;
      }
      return true;
    });

    // 3. Load existing artifacts for change detection
    const existing = await getObsidianArtifacts(pool);
    const existingByPath = new Map(existing.map((a) => [a.source_path, a]));

    // 4. Partition into new + changed
    const toSync = mdFiles.filter((obj) => {
      const ex = existingByPath.get(obj.key);
      return !ex || ex.content_hash !== obj.etag;
    });

    console.log(`[obsidian-sync] R2: ${mdFiles.length} files, ${existing.length} existing, ${toSync.length} to sync`);

    // 5. Download and parse in batches
    const upsertedArtifacts: Array<{ id: string; key: string; wikiLinks: string[]; title: string; body: string; kind: string }> = [];

    for (let i = 0; i < toSync.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = toSync.slice(i, i + DOWNLOAD_CONCURRENCY);
      const contents = await Promise.all(
        batch.map(async (obj) => {
          try {
            const content = await getObjectContent(r2Client, VAULT_BUCKET, obj.key);
            return { key: obj.key, etag: obj.etag, content };
          } catch (err) {
            errors.push({ file: obj.key, error: `Download failed: ${err instanceof Error ? err.message : "unknown"}` });
            return null;
          }
        })
      );

      // 6. Parse and upsert each file
      for (const item of contents) {
        if (!item) continue;
        try {
          const parsed = parseObsidianNote(item.content, item.key);
          for (const msg of parsed.dateParseErrors) {
            errors.push({ file: item.key, error: msg });
          }
          const id = await upsertObsidianArtifact(pool, {
            sourcePath: item.key,
            title: parsed.title,
            body: parsed.body,
            kind: parsed.kind,
            contentHash: item.etag,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          });

          upsertedArtifacts.push({ id, key: item.key, wikiLinks: parsed.wikiLinks, title: parsed.title, body: parsed.body, kind: parsed.kind });
          filesSynced++;
        } catch (err) {
          errors.push({ file: item.key, error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }

    // 7. Soft-delete artifacts whose files no longer exist in R2
    const activeKeys = mdFiles.map((obj) => obj.key);
    filesDeleted = await softDeleteMissingObsidianArtifacts(pool, activeKeys);
    if (filesDeleted > 0) {
      console.log(`[obsidian-sync] Soft-deleted ${filesDeleted} artifacts (paths no longer in R2)`);
    }

    // 8. Resolve wiki links (pass 2) — in-memory title map
    const allTitles = await pool.query<{ id: string; title: string; source_path: string | null }>(
      `SELECT id, title, source_path FROM knowledge_artifacts WHERE deleted_at IS NULL`
    );
    const titleToId = new Map<string, string>();
    const stemToId = new Map<string, string>();
    for (const row of allTitles.rows) {
      titleToId.set((row.title as string).toLowerCase(), row.id as string);
      if (row.source_path) {
        const stem = filenameStem(row.source_path as string).toLowerCase();
        stemToId.set(stem, row.id as string);
      }
    }

    for (const artifact of upsertedArtifacts) {
      const targetIds: string[] = [];
      for (const link of artifact.wikiLinks) {
        const linkLower = link.toLowerCase();
        const targetId = titleToId.get(linkLower) ?? stemToId.get(linkLower);
        if (targetId && targetId !== artifact.id) {
          targetIds.push(targetId);
        }
      }
      if (targetIds.length > 0) {
        await syncExplicitLinks(pool, artifact.id, targetIds);
        linksResolved += targetIds.length;
      }
    }

    await completeObsidianSyncRun(pool, runId, "success", filesSynced, filesDeleted, linksResolved, errors);
    return { runId, filesSynced, filesDeleted, linksResolved, errors, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Obsidian sync error";
    await completeObsidianSyncRun(pool, runId, "error", filesSynced, filesDeleted, linksResolved, [
      ...errors,
      { file: "*", error: message },
    ]);
    throw err;
  /* v8 ignore next 4 -- finally branch covered by both success and error paths */
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

// ============================================================================
// Timer
// ============================================================================

async function syncAndNotify(
  pool: pg.Pool,
  onAfterSync?: () => Promise<void>
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runObsidianSync(pool);
    logUsage(pool, {
      source: "cron",
      surface: "obsidian-sync",
      action: "obsidian-sync",
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: result
        ? {
            runId: result.runId,
            filesSynced: result.filesSynced,
            filesDeleted: result.filesDeleted,
            linksResolved: result.linksResolved,
            errors: result.errors,
          }
        : { skipped: true },
    });
    /* v8 ignore next 3 -- background callback is runtime-only */
    if (onAfterSync) {
      await onAfterSync();
    }
  /* v8 ignore next 11 -- background sync: errors already recorded in obsidian_sync_runs */
  } catch (err) {
    notifyError("Obsidian sync", err);
    logUsage(pool, {
      source: "cron",
      surface: "obsidian-sync",
      action: "obsidian-sync",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

export function startObsidianSyncTimer(
  pool: pg.Pool,
  onAfterSync?: () => Promise<void>
): NodeJS.Timeout | null {
  if (!config.r2.accountId || !config.r2.accessKeyId) return null;
  void syncAndNotify(pool, onAfterSync);
  /* v8 ignore next 3 — interval callback body is not testable in unit tests */
  return setInterval(() => {
    void syncAndNotify(pool, onAfterSync);
  }, SYNC_INTERVAL_MS);
}

// ============================================================================
// Helpers
// ============================================================================

function filenameStem(filepath: string): string {
  const base = filepath.includes("/")
    ? filepath.substring(filepath.lastIndexOf("/") + 1)
    : filepath;
  return base.replace(/\.md$/i, "");
}
