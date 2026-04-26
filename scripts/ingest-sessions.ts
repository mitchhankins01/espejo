/**
 * Manual ingest of Claude Code + OpenCode sessions into agent_sessions.
 *
 * Usage:
 *   pnpm ingest:sessions
 *   pnpm ingest:sessions --dry-run
 *   pnpm ingest:sessions --force
 *   pnpm ingest:sessions --since 2026-04-01
 *   pnpm ingest:sessions --surface claude-code|opencode
 *   pnpm ingest:sessions --skip-if-fresh 24h
 *
 * See specs/agent-sessions-ingestor.md.
 */
import "dotenv/config";
import { pool } from "../src/db/client.js";
import {
  upsertSession,
  latestSourceMtime,
  latestIngestedAt,
} from "../src/db/queries/agent-sessions.js";
import { logUsage } from "../src/db/queries/usage.js";
import {
  listEspejoProjectDirs,
  listSessionFiles,
  parseClaudeCodeSessionFile,
} from "../src/ingest/claude-code.js";
import { readOpencodeSessions } from "../src/ingest/opencode.js";
import {
  listCodexSessionFiles,
  parseCodexSessionFile,
} from "../src/ingest/codex.js";
import type { SessionSurface } from "../src/ingest/types.js";

const args = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (n: string) => args.includes(n);

const dryRun = has("--dry-run");
const force = has("--force");
const includeNoise = has("--include-noise"); // keep dev/automation/throwaway rows
const sinceArg = arg("--since");
const surfaceArg = arg("--surface") as SessionSurface | null;
const skipIfFresh = arg("--skip-if-fresh"); // e.g. "24h", "30m"

const NOISE_CATEGORIES = new Set(["dev", "automation", "throwaway"]);

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

interface SurfaceStats {
  scanned: number;
  upserted: number;
  skipped: number;
  errors: number;
  // Per-category counts of what we saw (whether kept or filtered)
  categories: Record<string, number>;
}

function blankStats(): SurfaceStats {
  return { scanned: 0, upserted: 0, skipped: 0, errors: 0, categories: {} };
}

async function ingestClaudeCode(sinceOverride: Date | null): Promise<SurfaceStats> {
  const stats = blankStats();
  const since = sinceOverride ?? (force ? null : await latestSourceMtime(pool, "claude-code"));
  log(`claude-code: since = ${since?.toISOString() ?? "(beginning)"}`);

  const projectDirs = listEspejoProjectDirs();
  log(`claude-code: ${projectDirs.length} espejo-relevant project dirs`);

  for (const dir of projectDirs) {
    const files = listSessionFiles(dir, since);
    for (const f of files) {
      stats.scanned++;
      try {
        const row = await parseClaudeCodeSessionFile(f.path, f.mtime);
        if (!row) {
          stats.skipped++;
          continue;
        }
        stats.categories[row.category] = (stats.categories[row.category] || 0) + 1;
        if (!includeNoise && NOISE_CATEGORIES.has(row.category)) {
          stats.skipped++;
          continue;
        }
        if (!dryRun) await upsertSession(pool, row);
        stats.upserted++;
      } catch (err) {
        stats.errors++;
        console.error(`  parse error in ${f.path}:`, err);
      }
    }
  }
  return stats;
}

async function ingestCodex(sinceOverride: Date | null): Promise<SurfaceStats> {
  const stats = blankStats();
  const since = sinceOverride ?? (force ? null : await latestSourceMtime(pool, "codex"));
  log(`codex: since = ${since?.toISOString() ?? "(beginning)"}`);

  const files = listCodexSessionFiles({ sinceMtime: since });
  log(`codex: ${files.length} candidate session files`);
  for (const f of files) {
    stats.scanned++;
    try {
      const row = await parseCodexSessionFile(f.path, f.mtime);
      if (!row) {
        stats.skipped++; // not espejo or no session_meta
        continue;
      }
      stats.categories[row.category] = (stats.categories[row.category] || 0) + 1;
      if (!includeNoise && NOISE_CATEGORIES.has(row.category)) {
        stats.skipped++;
        continue;
      }
      if (!dryRun) await upsertSession(pool, row);
      stats.upserted++;
    } catch (err) {
      stats.errors++;
      console.error(`  parse error in ${f.path}:`, err);
    }
  }
  return stats;
}

async function ingestOpencode(sinceOverride: Date | null): Promise<SurfaceStats> {
  const stats = blankStats();
  const since = sinceOverride ?? (force ? null : await latestSourceMtime(pool, "opencode"));
  log(`opencode: since (time_updated) = ${since?.toISOString() ?? "(beginning)"}`);

  let rows;
  try {
    rows = readOpencodeSessions({ sinceUpdated: since });
  } catch (err) {
    stats.errors++;
    console.error("  opencode db read failed:", err);
    return stats;
  }
  stats.scanned = rows.length;
  for (const row of rows) {
    try {
      stats.categories[row.category] = (stats.categories[row.category] || 0) + 1;
      if (!includeNoise && NOISE_CATEGORIES.has(row.category)) {
        stats.skipped++;
        continue;
      }
      if (!dryRun) await upsertSession(pool, row);
      stats.upserted++;
    } catch (err) {
      stats.errors++;
      console.error(`  upsert failed for ${row.session_id}:`, err);
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const start = Date.now();

  // Freshness short-circuit
  if (skipIfFresh) {
    const lastIngest = await latestIngestedAt(pool);
    if (lastIngest) {
      const ageMs = Date.now() - lastIngest.getTime();
      if (ageMs < parseDuration(skipIfFresh)) {
        const ageHours = (ageMs / 3_600_000).toFixed(1);
        console.log(
          `[ingest:sessions] fresh — last ingest ${ageHours}h ago (< ${skipIfFresh}). Skipping.`
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

  const stats: Record<SessionSurface, SurfaceStats> = {
    "claude-code": blankStats(),
    opencode: blankStats(),
    codex: blankStats(),
  };

  if (!surfaceArg || surfaceArg === "claude-code") {
    stats["claude-code"] = await ingestClaudeCode(since);
  }
  if (!surfaceArg || surfaceArg === "opencode") {
    stats["opencode"] = await ingestOpencode(since);
  }
  if (!surfaceArg || surfaceArg === "codex") {
    stats["codex"] = await ingestCodex(since);
  }

  const durationMs = Date.now() - start;

  console.log();
  console.log("ingest:sessions summary");
  console.log("  claude-code:", stats["claude-code"]);
  console.log("  opencode:   ", stats.opencode);
  console.log("  codex:      ", stats.codex);
  console.log(`  duration:    ${durationMs}ms`);

  // Log to usage_logs (skip in dry-run to avoid polluting logs)
  if (!dryRun) {
    const allOk =
      stats["claude-code"].errors === 0 &&
      stats.opencode.errors === 0 &&
      stats.codex.errors === 0;
    logUsage(pool, {
      source: "script",
      surface: "ingest-sessions",
      action: "ingest:sessions",
      ok: allOk,
      durationMs,
      meta: {
        claude_code: stats["claude-code"],
        opencode: stats.opencode,
        codex: stats.codex,
        force,
        since: sinceArg,
        surface: surfaceArg,
      },
    });
    // Wait briefly for the fire-and-forget logUsage write
    await new Promise((r) => setTimeout(r, 100));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end().finally(() => process.exit(1));
});
