import type pg from "pg";
import { config } from "../config.js";
import {
  completeOuraSyncRun,
  insertOuraHeartrateBatch,
  insertOuraSyncRun,
  upsertOuraDailyActivity,
  upsertOuraDailyCardiovascularAge,
  upsertOuraDailyReadiness,
  upsertOuraDailyResilience,
  upsertOuraDailySleep,
  upsertOuraDailySpo2,
  upsertOuraDailyStress,
  upsertOuraPersonalInfo,
  upsertOuraRingConfiguration,
  upsertOuraEnhancedTag,
  upsertOuraRestModePeriod,
  upsertOuraSession,
  upsertOuraSleepSession,
  upsertOuraSleepTime,
  upsertOuraSyncState,
  upsertOuraWorkout,
} from "../db/queries.js";
import { logUsage } from "../db/queries/usage.js";
import { notifyError } from "../telegram/notify.js";
import { todayInTimezone, daysAgoInTimezone } from "../utils/dates.js";
import { OuraClient } from "./client.js";

const LOCK_KEY = 9152201;

export interface OuraSyncResult {
  runId: number;
  total: number;
  counts: {
    sleep: number;
    sessions: number;
    readiness: number;
    activity: number;
    stress: number;
    workouts: number;
    spo2: number;
    resilience: number;
    cv_age: number;
    sleep_time: number;
    enhanced_tags: number;
    rest_mode: number;
    meditation_sessions: number;
    heartrate: number;
    personal_info: number;
    ring_configurations: number;
  };
  durationMs: number;
}

export async function runOuraSync(pool: pg.Pool, lookbackDays: number): Promise<OuraSyncResult | null> {
  if (!config.oura.accessToken) return null;
  const lock = await pool.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
  if (!lock.rows[0]?.ok) return null;

  const runId = await insertOuraSyncRun(pool);
  const client = new OuraClient();
  const startDate = daysAgoInTimezone(lookbackDays);
  const endDate = todayInTimezone();
  const t0 = Date.now();

  try {
    const [
      dailySleep, sleepSessions, readiness, activity, stress, workouts,
      spo2, resilience, cvAge, sleepTime, enhancedTags, restModePeriods, meditationSessions,
      personalInfo, ringConfigs,
    ] = await Promise.all([
      client.getDailySleep(startDate, endDate),
      client.getSleepSessions(startDate, endDate),
      client.getDailyReadiness(startDate, endDate),
      client.getDailyActivity(startDate, endDate),
      client.getDailyStress(startDate, endDate),
      client.getWorkouts(startDate, endDate),
      client.getDailySpo2(startDate, endDate),
      client.getDailyResilience(startDate, endDate),
      client.getDailyCardiovascularAge(startDate, endDate),
      client.getSleepTime(startDate, endDate),
      client.getEnhancedTags(startDate, endDate),
      client.getRestModePeriods(startDate, endDate),
      client.getSessions(startDate, endDate),
      client.getPersonalInfo(),
      client.getRingConfigurations(startDate, endDate),
    ]);

    await Promise.all(dailySleep.map((row) => upsertOuraDailySleep(pool, row)));
    await Promise.all(sleepSessions.map((row) => upsertOuraSleepSession(pool, row)));
    await Promise.all(readiness.map((row) => upsertOuraDailyReadiness(pool, row)));
    await Promise.all(activity.map((row) => upsertOuraDailyActivity(pool, row)));
    await Promise.all(stress.map((row) => upsertOuraDailyStress(pool, row)));
    await Promise.all(workouts.map((row) => upsertOuraWorkout(pool, row)));
    await Promise.all(spo2.map((row) => upsertOuraDailySpo2(pool, row)));
    await Promise.all(resilience.map((row) => upsertOuraDailyResilience(pool, row)));
    await Promise.all(cvAge.map((row) => upsertOuraDailyCardiovascularAge(pool, row)));
    await Promise.all(sleepTime.map((row) => upsertOuraSleepTime(pool, row)));
    await Promise.all(enhancedTags.map((row) => upsertOuraEnhancedTag(pool, row)));
    await Promise.all(restModePeriods.map((row) => upsertOuraRestModePeriod(pool, row)));
    await Promise.all(meditationSessions.map((row) => upsertOuraSession(pool, row)));
    if (personalInfo) await upsertOuraPersonalInfo(pool, personalInfo);
    await Promise.all(ringConfigs.map((row) => upsertOuraRingConfiguration(pool, row)));

    // Continuous heart rate (5-min rest/awake + per-second workout). Bounded by
    // lookback window. Backfill is a separate script.
    const heartrateRows = await client.getHeartrate(`${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`);
    const heartrateBatch = heartrateRows
      .map((r) => ({
        ts: r.timestamp as string,
        bpm: typeof r.bpm === "number" ? Math.round(r.bpm) : 0,
        source: (r.source as string) ?? "unknown",
      }))
      .filter((r) => r.ts && r.bpm > 0);
    const heartrateInserted = (await insertOuraHeartrateBatch(pool, heartrateBatch)) ?? 0;

    await upsertOuraSyncState(pool, "all", endDate);
    const counts = {
      sleep: dailySleep.length,
      sessions: sleepSessions.length,
      readiness: readiness.length,
      activity: activity.length,
      stress: stress.length,
      workouts: workouts.length,
      spo2: spo2.length,
      resilience: resilience.length,
      cv_age: cvAge.length,
      sleep_time: sleepTime.length,
      enhanced_tags: enhancedTags.length,
      rest_mode: restModePeriods.length,
      meditation_sessions: meditationSessions.length,
      heartrate: heartrateInserted,
      personal_info: personalInfo ? 1 : 0,
      ring_configurations: ringConfigs.length,
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await completeOuraSyncRun(pool, runId, "success", total, null);
    return { runId, total, counts, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Oura sync error";
    await completeOuraSyncRun(pool, runId, "failed", 0, message);
    throw err;
  /* v8 ignore next 4 -- finally branch covered by both success and error tests */
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

async function syncAndNotify(
  pool: pg.Pool,
  lookbackDays: number,
  onAfterSync?: () => Promise<void>
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runOuraSync(pool, lookbackDays);
    logUsage(pool, {
      source: "cron",
      surface: "oura-sync",
      action: "oura-sync",
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: result
        ? { lookbackDays, total: result.total, counts: result.counts, runId: result.runId }
        : { lookbackDays, skipped: true },
    });
    /* v8 ignore next 9 -- background sync: errors already recorded in oura_sync_runs */
  } catch (err) {
    notifyError("Oura sync", err);
    logUsage(pool, {
      source: "cron",
      surface: "oura-sync",
      action: "oura-sync",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      meta: { lookbackDays },
    });
  } finally {
    if (onAfterSync) {
      await onAfterSync();
    }
  }
}

export function startOuraSyncTimer(
  pool: pg.Pool,
  onAfterSync?: () => Promise<void>
): NodeJS.Timeout | null {
  if (!config.oura.accessToken) return null;
  void syncAndNotify(pool, 30, onAfterSync);
  /* v8 ignore next 3 — interval callback body is not testable in unit tests */
  return setInterval(() => {
    void syncAndNotify(pool, config.oura.syncLookbackDays, onAfterSync);
  }, config.oura.syncIntervalMinutes * 60_000);
}
