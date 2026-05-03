/**
 * Activity capture ingestor: ActivityWatch + Atuin + Screenpipe.
 *
 * Usage:
 *   pnpm ingest:activity
 *   pnpm ingest:activity --dry-run
 *   pnpm ingest:activity --force                   # ignore watermark, full backfill
 *   pnpm ingest:activity --since 2026-04-01
 *   pnpm ingest:activity --source aw|atuin|screenpipe
 *   pnpm ingest:activity --skip-if-fresh 24h
 *
 * See specs/2026-05-03-activity-capture-plan.md (Phases 2–4).
 */
import "dotenv/config";
import { pool } from "../src/db/client.js";
import {
  upsertDeviceEvents,
  latestStartedAt,
  latestDeviceEventIngestedAt,
  type UpsertDeviceEventInput,
} from "../src/db/queries/device-events.js";
import {
  bulkInsertUsageLogs,
  latestUsageLogTs,
  logUsage,
  type LogUsageInput,
} from "../src/db/queries/usage.js";
import {
  ACTIVITYWATCH_SOURCE,
  readActivityWatchEvents,
} from "../src/ingest/activitywatch.js";
import { ATUIN_SOURCE, readAtuinHistory } from "../src/ingest/atuin.js";
import {
  readScreenpipeChunks,
  type ScreenCaptureChunk,
} from "../src/ingest/screenpipe.js";
import {
  upsertScreenCaptures,
  latestScreenCaptureStartedAt,
  pruneOldScreenCaptures,
  type UpsertScreenCaptureInput,
} from "../src/db/queries/screen-captures.js";
import { generateEmbeddingsBatch } from "../src/db/embeddings.js";

type ActivitySource = "aw" | "atuin" | "screenpipe";

const args = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (n: string) => args.includes(n);

const dryRun = has("--dry-run");
const force = has("--force");
const sinceArg = arg("--since");
const sourceArg = arg("--source") as ActivitySource | null;
const skipIfFresh = arg("--skip-if-fresh");

// Default backfill window when nothing has been ingested yet.
const DEFAULT_BACKFILL_DAYS = 7;
const ATUIN_DEFAULT_BACKFILL_DAYS = 30;
const SCREENPIPE_DEFAULT_BACKFILL_DAYS = 7;
// text-embedding-3-small batch size. Mirrors scripts/embed-entries.ts.
const EMBED_BATCH = 100;
// Cap each chunk's combined OCR+audio at ~30k chars before embedding to stay
// under the 8192-token model limit. Mirrors scripts/embed-entries.ts.
const MAX_EMBED_CHARS = 30_000;
// Tiered-retention window for OCR/audio text (matches phase-4 spec).
const SCREENPIPE_RETENTION_DAYS = 14;

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*([mhd])$/);
  if (!m) throw new Error(`Bad duration: ${s} (expected e.g. 24h, 30m)`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  throw new Error(`Bad unit: ${unit}`);
}

function log(...a: unknown[]): void {
  console.log(dryRun ? "[DRY]" : "     ", ...a);
}

interface SourceStats {
  scanned: number;
  upserted: number;
  skipped: number;
  errors: number;
  buckets: Record<string, number>;
}

function blankStats(): SourceStats {
  return { scanned: 0, upserted: 0, skipped: 0, errors: 0, buckets: {} };
}

async function ingestActivityWatch(
  sinceOverride: Date | null
): Promise<SourceStats> {
  const stats = blankStats();
  const watermark = force
    ? null
    : await latestStartedAt(pool, ACTIVITYWATCH_SOURCE);
  const fallback = new Date(
    Date.now() - DEFAULT_BACKFILL_DAYS * 86_400_000
  );
  const since = sinceOverride ?? watermark ?? fallback;
  log(`activitywatch: since = ${since.toISOString()}`);

  let events: UpsertDeviceEventInput[];
  try {
    events = readActivityWatchEvents({ since });
  } catch (err) {
    stats.errors++;
    console.error("  activitywatch read failed:", err);
    return stats;
  }
  stats.scanned = events.length;
  for (const ev of events) {
    stats.buckets[ev.bucket] = (stats.buckets[ev.bucket] || 0) + 1;
  }

  if (events.length === 0) {
    log("activitywatch: no new events");
    return stats;
  }

  if (dryRun) {
    stats.skipped = events.length;
    log(`activitywatch: ${events.length} events (dry-run, not written)`);
    return stats;
  }

  // Chunk to keep transaction sizes reasonable.
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    try {
      await upsertDeviceEvents(pool, slice);
      stats.upserted += slice.length;
    } catch (err) {
      stats.errors++;
      console.error(
        `  activitywatch upsert failed at chunk ${i}–${i + slice.length}:`,
        err
      );
    }
  }
  return stats;
}

async function ingestAtuin(sinceOverride: Date | null): Promise<SourceStats> {
  const stats = blankStats();
  const watermark = force ? null : await latestUsageLogTs(pool, ATUIN_SOURCE);
  const fallback = new Date(
    Date.now() - ATUIN_DEFAULT_BACKFILL_DAYS * 86_400_000
  );
  const since = sinceOverride ?? watermark ?? fallback;
  log(`atuin: since = ${since.toISOString()}`);

  let rows: ReturnType<typeof readAtuinHistory>;
  try {
    rows = readAtuinHistory({ since });
  } catch (err) {
    stats.errors++;
    console.error("  atuin read failed:", err);
    return stats;
  }
  stats.scanned = rows.length;
  // No buckets concept for atuin; use exit-code success/failure as the
  // breakdown so the summary is still useful. atuin's `-1` sentinel means
  // "no exit captured" (typically zsh import or shell exited mid-command),
  // not "command failed" — bucket those separately.
  for (const r of rows) {
    const key = r.exit === 0 ? "ok" : r.exit < 0 ? "unknown" : "fail";
    stats.buckets[key] = (stats.buckets[key] || 0) + 1;
  }

  if (rows.length === 0) {
    log("atuin: no new commands");
    return stats;
  }

  if (dryRun) {
    stats.skipped = rows.length;
    log(`atuin: ${rows.length} commands (dry-run, not written)`);
    return stats;
  }

  const inputs: (LogUsageInput & { ts: Date })[] = rows.map((r) => ({
    source: ATUIN_SOURCE,
    surface: r.hostname || undefined,
    actor: r.cwd || undefined,
    action: r.verb,
    args: {
      cmd: r.cmd,
      cwd: r.cwd,
      host: r.hostname,
      exit: r.exit,
      duration_ms: r.durationMs,
      atuin_id: r.atuinId,
      session: r.session,
    },
    // exit < 0 is atuin's "unknown" (imported or unfinished). Don't classify
    // those as failures — they'd otherwise dominate any "what errored" query.
    ok: r.exit <= 0,
    error: r.exit > 0 ? String(r.exit) : undefined,
    durationMs: r.durationMs,
    ts: r.ts,
  }));

  const CHUNK = 500;
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const slice = inputs.slice(i, i + CHUNK);
    try {
      await bulkInsertUsageLogs(pool, slice);
      stats.upserted += slice.length;
    } catch (err) {
      stats.errors++;
      console.error(
        `  atuin insert failed at chunk ${i}–${i + slice.length}:`,
        err
      );
    }
  }
  return stats;
}

async function ingestScreenpipe(
  sinceOverride: Date | null
): Promise<SourceStats & { embedded: number; pruned: number }> {
  const stats = {
    ...blankStats(),
    embedded: 0,
    pruned: 0,
  };
  const watermark = force ? null : await latestScreenCaptureStartedAt(pool);
  const fallback = new Date(
    Date.now() - SCREENPIPE_DEFAULT_BACKFILL_DAYS * 86_400_000
  );
  const since = sinceOverride ?? watermark ?? fallback;
  log(`screenpipe: since = ${since.toISOString()}`);

  let chunks: ScreenCaptureChunk[];
  try {
    chunks = readScreenpipeChunks({ since });
  } catch (err) {
    stats.errors++;
    console.error("  screenpipe read failed:", err);
    return stats;
  }
  stats.scanned = chunks.length;
  // "buckets" here is by app — gives a quick read on what dominated the window.
  for (const c of chunks) {
    stats.buckets[c.app] = (stats.buckets[c.app] || 0) + 1;
  }

  if (chunks.length === 0) {
    log("screenpipe: no new chunks");
    return stats;
  }

  if (dryRun) {
    stats.skipped = chunks.length;
    log(`screenpipe: ${chunks.length} chunks (dry-run, not written/embedded)`);
    return stats;
  }

  // Embed in batches. Concat OCR + audio for each chunk; cap length so the
  // model doesn't reject the request.
  const embeddings = new Array<number[] | null>(chunks.length).fill(null);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const slice = chunks.slice(i, i + EMBED_BATCH);
    const inputs = slice.map((c) => {
      const combined = [c.ocrText, c.audioText].filter(Boolean).join("\n");
      return combined.length > MAX_EMBED_CHARS
        ? combined.slice(0, MAX_EMBED_CHARS)
        : combined;
    });
    try {
      const vecs = await generateEmbeddingsBatch(inputs);
      for (let j = 0; j < vecs.length; j++) {
        embeddings[i + j] = vecs[j];
      }
      stats.embedded += vecs.length;
    } catch (err) {
      stats.errors++;
      console.error(
        `  screenpipe embed failed at chunk ${i}–${i + slice.length}:`,
        err
      );
      // Leave embeddings as null — upsert will still write the row, embedding
      // can be backfilled later with --force.
    }
  }

  const inputs: UpsertScreenCaptureInput[] = chunks.map((c, idx) => ({
    sourceChunkId: c.sourceChunkId,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    app: c.app || null,
    windowName: c.window || null,
    ocrText: c.ocrText || null,
    audioText: c.audioText,
    embedding: embeddings[idx],
    data: c.data,
  }));

  const CHUNK = 500;
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const slice = inputs.slice(i, i + CHUNK);
    try {
      await upsertScreenCaptures(pool, slice);
      stats.upserted += slice.length;
    } catch (err) {
      stats.errors++;
      console.error(
        `  screenpipe upsert failed at chunk ${i}–${i + slice.length}:`,
        err
      );
    }
  }

  // Tiered retention: shrink old rows.
  try {
    stats.pruned = await pruneOldScreenCaptures(pool, SCREENPIPE_RETENTION_DAYS);
  } catch (err) {
    stats.errors++;
    console.error("  screenpipe prune failed:", err);
  }

  return stats;
}

async function main(): Promise<void> {
  const start = Date.now();

  if (skipIfFresh) {
    // Freshness is keyed off the most recent successful run of this script
    // (via the summary row it writes to usage_logs at the end). That covers
    // every source the script handles, not just ActivityWatch's last event.
    const lastRun = await pool.query<{ ts: Date | null }>(
      `SELECT MAX(ts) AS ts FROM usage_logs
        WHERE source = 'script' AND surface = 'ingest-activity' AND ok = TRUE`
    );
    const lastRunTs =
      lastRun.rows[0]?.ts ??
      // Fall back to the AW-events watermark for legacy installs that have
      // ingested events but never recorded a script summary row.
      (await latestDeviceEventIngestedAt(pool));
    if (lastRunTs) {
      const ageMs = Date.now() - lastRunTs.getTime();
      if (ageMs < parseDuration(skipIfFresh)) {
        const ageHours = (ageMs / 3_600_000).toFixed(1);
        console.log(
          `[ingest:activity] fresh — last ingest ${ageHours}h ago (< ${skipIfFresh}). Skipping.`
        );
        await pool.end();
        return;
      }
    }
  }

  const since = sinceArg ? new Date(sinceArg) : null;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`Bad --since value: ${sinceArg}`);
    process.exit(1);
  }

  const stats = {
    aw: blankStats(),
    atuin: blankStats(),
    screenpipe: { ...blankStats(), embedded: 0, pruned: 0 },
  };

  if (!sourceArg || sourceArg === "aw") {
    stats.aw = await ingestActivityWatch(since);
  }
  if (!sourceArg || sourceArg === "atuin") {
    stats.atuin = await ingestAtuin(since);
  }
  if (!sourceArg || sourceArg === "screenpipe") {
    stats.screenpipe = await ingestScreenpipe(since);
  }

  const durationMs = Date.now() - start;

  console.log();
  console.log("ingest:activity summary");
  console.log("  activitywatch:", stats.aw);
  console.log("  atuin:        ", stats.atuin);
  console.log("  screenpipe:   ", stats.screenpipe);
  console.log(`  duration:      ${durationMs}ms`);

  if (!dryRun) {
    const allOk =
      stats.aw.errors === 0 &&
      stats.atuin.errors === 0 &&
      stats.screenpipe.errors === 0;
    logUsage(pool, {
      source: "script",
      surface: "ingest-activity",
      action: "ingest:activity",
      ok: allOk,
      durationMs,
      meta: {
        activitywatch: stats.aw,
        atuin: stats.atuin,
        screenpipe: stats.screenpipe,
        force,
        since: sinceArg,
        source: sourceArg,
      },
    });
    await new Promise((r) => setTimeout(r, 100));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end().finally(() => process.exit(1));
});
