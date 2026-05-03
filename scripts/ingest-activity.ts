/**
 * Activity capture ingestor: ActivityWatch (today), Atuin + Screenpipe (later).
 *
 * Usage:
 *   pnpm ingest:activity
 *   pnpm ingest:activity --dry-run
 *   pnpm ingest:activity --force                   # ignore watermark, full backfill
 *   pnpm ingest:activity --since 2026-04-01
 *   pnpm ingest:activity --source aw|atuin|screenpipe
 *   pnpm ingest:activity --skip-if-fresh 24h
 *
 * See specs/2026-05-03-activity-capture-plan.md (Phase 2).
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

  const stats: Record<ActivitySource, SourceStats> = {
    aw: blankStats(),
    atuin: blankStats(),
    screenpipe: blankStats(),
  };

  if (!sourceArg || sourceArg === "aw") {
    stats.aw = await ingestActivityWatch(since);
  }
  if (!sourceArg || sourceArg === "atuin") {
    stats.atuin = await ingestAtuin(since);
  }
  if (sourceArg === "screenpipe") {
    log("screenpipe: deferred (phase 4)");
  }

  const durationMs = Date.now() - start;

  console.log();
  console.log("ingest:activity summary");
  console.log("  activitywatch:", stats.aw);
  console.log("  atuin:        ", stats.atuin);
  console.log(`  duration:      ${durationMs}ms`);

  if (!dryRun) {
    const allOk = stats.aw.errors === 0 && stats.atuin.errors === 0;
    logUsage(pool, {
      source: "script",
      surface: "ingest-activity",
      action: "ingest:activity",
      ok: allOk,
      durationMs,
      meta: {
        activitywatch: stats.aw,
        atuin: stats.atuin,
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
