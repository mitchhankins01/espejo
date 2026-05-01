// One-shot Oura history backfill. Idempotent — every upsert is ON CONFLICT DO
// UPDATE. Designed to be run once after migration 045 to populate the new
// tables (spo2/resilience/cv_age/sleep_time/tags/rest_mode/meditation sessions/
// continuous heartrate) and to refresh existing tables so promoted columns
// pick up data they may have missed before the column was added.
//
// Usage:
//   pnpm tsx scripts/backfill-oura.ts                 # default: full history
//   pnpm tsx scripts/backfill-oura.ts --since 2024-01-01
//   pnpm tsx scripts/backfill-oura.ts --skip heartrate # skip heartrate (slow)

import { pool } from "../src/db/client.js";
import { OuraClient } from "../src/oura/client.js";
import {
  insertOuraHeartrateBatch,
  upsertOuraDailyActivity,
  upsertOuraDailyCardiovascularAge,
  upsertOuraDailyReadiness,
  upsertOuraDailyResilience,
  upsertOuraDailySleep,
  upsertOuraDailySpo2,
  upsertOuraDailyStress,
  upsertOuraEnhancedTag,
  upsertOuraPersonalInfo,
  upsertOuraRestModePeriod,
  upsertOuraRingConfiguration,
  upsertOuraSession,
  upsertOuraSleepSession,
  upsertOuraSleepTime,
  upsertOuraWorkout,
} from "../src/db/queries.js";

const DEFAULT_SINCE = "2020-01-01";
const HEARTRATE_DEFAULT_SINCE = "2022-09-01";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function* dateChunks(start: string, end: string, days: number): Generator<[string, string]> {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  const stepMs = days * 86400000;
  for (let cursor = startMs; cursor < endMs; cursor += stepMs) {
    const a = new Date(cursor).toISOString().slice(0, 10);
    const b = new Date(Math.min(cursor + stepMs, endMs)).toISOString().slice(0, 10);
    yield [a, b];
  }
}

async function main(): Promise<void> {
  const since = arg("since") ?? DEFAULT_SINCE;
  const until = arg("until") ?? todayUtc();
  const skipHeartrate = flag("skip-heartrate");
  const skipList = (arg("skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skip = (name: string): boolean => skipList.includes(name);

  const client = new OuraClient();

  if (!skip("daily_activity")) {
    console.log(`[daily_activity] ${since} → ${until}`);
    const rows = await client.getDailyActivity(since, until);
    for (const row of rows) await upsertOuraDailyActivity(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_sleep")) {
    console.log(`[daily_sleep] ${since} → ${until}`);
    const rows = await client.getDailySleep(since, until);
    for (const row of rows) await upsertOuraDailySleep(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_readiness")) {
    console.log(`[daily_readiness] ${since} → ${until}`);
    const rows = await client.getDailyReadiness(since, until);
    for (const row of rows) await upsertOuraDailyReadiness(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_stress")) {
    console.log(`[daily_stress] ${since} → ${until}`);
    const rows = await client.getDailyStress(since, until);
    for (const row of rows) await upsertOuraDailyStress(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("sleep")) {
    // Sleep sessions are heavier (per-night time series). Chunk to avoid huge responses.
    console.log(`[sleep sessions] ${since} → ${until}`);
    let total = 0;
    for (const [a, b] of dateChunks(since, until, 90)) {
      const rows = await client.getSleepSessions(a, b);
      for (const row of rows) await upsertOuraSleepSession(pool, row);
      total += rows.length;
      console.log(`  ${a} → ${b}: ${rows.length} sessions (running total: ${total})`);
    }
    console.log(`  upserted ${total}`);
  }

  if (!skip("workouts")) {
    console.log(`[workouts] ${since} → ${until}`);
    const rows = await client.getWorkouts(since, until);
    for (const row of rows) await upsertOuraWorkout(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_spo2")) {
    console.log(`[daily_spo2] ${since} → ${until}`);
    const rows = await client.getDailySpo2(since, until);
    for (const row of rows) await upsertOuraDailySpo2(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_resilience")) {
    console.log(`[daily_resilience] ${since} → ${until}`);
    const rows = await client.getDailyResilience(since, until);
    for (const row of rows) await upsertOuraDailyResilience(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("daily_cardiovascular_age")) {
    console.log(`[daily_cardiovascular_age] ${since} → ${until}`);
    const rows = await client.getDailyCardiovascularAge(since, until);
    for (const row of rows) await upsertOuraDailyCardiovascularAge(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("sleep_time")) {
    console.log(`[sleep_time] ${since} → ${until}`);
    const rows = await client.getSleepTime(since, until);
    for (const row of rows) await upsertOuraSleepTime(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("enhanced_tags")) {
    console.log(`[enhanced_tags] ${since} → ${until}`);
    const rows = await client.getEnhancedTags(since, until);
    for (const row of rows) await upsertOuraEnhancedTag(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("rest_mode")) {
    console.log(`[rest_mode_period] ${since} → ${until}`);
    const rows = await client.getRestModePeriods(since, until);
    for (const row of rows) await upsertOuraRestModePeriod(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("sessions")) {
    console.log(`[sessions/meditation] ${since} → ${until}`);
    const rows = await client.getSessions(since, until);
    for (const row of rows) await upsertOuraSession(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skip("personal_info")) {
    console.log(`[personal_info]`);
    const info = await client.getPersonalInfo();
    if (info) {
      await upsertOuraPersonalInfo(pool, info);
      console.log(`  upserted 1`);
    } else {
      console.log(`  upserted 0`);
    }
  }

  if (!skip("ring_configurations")) {
    console.log(`[ring_configurations] ${since} → ${until}`);
    const rows = await client.getRingConfigurations(since, until);
    for (const row of rows) await upsertOuraRingConfiguration(pool, row);
    console.log(`  upserted ${rows.length}`);
  }

  if (!skipHeartrate && !skip("heartrate")) {
    // Heartrate is voluminous (~3M rows over 3.5 years). Chunk by day to keep
    // memory usage bounded and to make resumes practical if interrupted.
    const hrSince = since < HEARTRATE_DEFAULT_SINCE ? HEARTRATE_DEFAULT_SINCE : since;
    console.log(`[heartrate] ${hrSince} → ${until} (this is the slow one)`);
    let total = 0;
    let chunkIdx = 0;
    for (const [a, b] of dateChunks(hrSince, until, 1)) {
      const rows = await client.getHeartrate(`${a}T00:00:00Z`, `${b}T00:00:00Z`);
      const batch = rows
        .map((r) => ({
          ts: r.timestamp as string,
          bpm: typeof r.bpm === "number" ? Math.round(r.bpm) : 0,
          source: (r.source as string) ?? "unknown",
        }))
        .filter((r) => r.ts && r.bpm > 0);
      const inserted = await insertOuraHeartrateBatch(pool, batch);
      total += inserted;
      chunkIdx++;
      if (chunkIdx % 10 === 0 || rows.length > 0) {
        console.log(`  ${a}: ${rows.length} samples (inserted ${inserted}, running total: ${total})`);
      }
    }
    console.log(`  inserted ${total}`);
  }

  console.log("Backfill complete.");
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
