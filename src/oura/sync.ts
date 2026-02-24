import type pg from "pg";
import { config } from "../config.js";
import {
  completeOuraSyncRun,
  insertOuraSyncRun,
  upsertOuraDailyActivity,
  upsertOuraDailyReadiness,
  upsertOuraDailySleep,
  upsertOuraDailyStress,
  upsertOuraSleepSession,
  upsertOuraSyncState,
  upsertOuraWorkout,
} from "../db/queries.js";
import { todayInTimezone, daysAgoInTimezone } from "../utils/dates.js";
import { OuraClient } from "./client.js";

const LOCK_KEY = 9152201;

export async function runOuraSync(pool: pg.Pool, lookbackDays: number): Promise<void> {
  if (!config.oura.accessToken) return;
  const lock = await pool.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
  if (!lock.rows[0]?.ok) return;

  const runId = await insertOuraSyncRun(pool);
  const client = new OuraClient();
  const startDate = daysAgoInTimezone(lookbackDays);
  const endDate = todayInTimezone();

  try {
    const [dailySleep, sleepSessions, readiness, activity, stress, workouts] = await Promise.all([
      client.getDailySleep(startDate, endDate),
      client.getSleepSessions(startDate, endDate),
      client.getDailyReadiness(startDate, endDate),
      client.getDailyActivity(startDate, endDate),
      client.getDailyStress(startDate, endDate),
      client.getWorkouts(startDate, endDate),
    ]);

    await Promise.all(dailySleep.map((row) => upsertOuraDailySleep(pool, row)));
    await Promise.all(sleepSessions.map((row) => upsertOuraSleepSession(pool, row)));
    await Promise.all(readiness.map((row) => upsertOuraDailyReadiness(pool, row)));
    await Promise.all(activity.map((row) => upsertOuraDailyActivity(pool, row)));
    await Promise.all(stress.map((row) => upsertOuraDailyStress(pool, row)));
    await Promise.all(workouts.map((row) => upsertOuraWorkout(pool, row)));

    await upsertOuraSyncState(pool, "all", endDate);
    const total = dailySleep.length + sleepSessions.length + readiness.length + activity.length + stress.length + workouts.length;
    await completeOuraSyncRun(pool, runId, "success", total, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Oura sync error";
    await completeOuraSyncRun(pool, runId, "failed", 0, message);
    throw err;
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

export function startOuraSyncTimer(pool: pg.Pool): NodeJS.Timeout | null {
  if (!config.oura.accessToken) return null;
  void runOuraSync(pool, 30);
  /* v8 ignore next 3 — interval callback body is not testable in unit tests */
  return setInterval(() => {
    void runOuraSync(pool, config.oura.syncLookbackDays);
  }, config.oura.syncIntervalMinutes * 60_000);
}
