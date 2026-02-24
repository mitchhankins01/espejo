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
import { sendTelegramMessage } from "../telegram/client.js";
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
    const counts = {
      sleep: dailySleep.length,
      sessions: sleepSessions.length,
      readiness: readiness.length,
      activity: activity.length,
      stress: stress.length,
      workouts: workouts.length,
    };
    const total = counts.sleep + counts.sessions + counts.readiness + counts.activity + counts.stress + counts.workouts;
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

export function notifyOuraSync(result: OuraSyncResult): void {
  const chatId = config.telegram.allowedChatId;
  const token = config.telegram.botToken;
  if (!token || !chatId) return;

  const secs = Math.round(result.durationMs / 1000);
  const text = `Oura sync \u2014 ${result.total} records (${secs}s)`;
  const { sleep, sessions, readiness, activity, stress, workouts } = result.counts;
  const callbackData = `oura_sync:${result.runId}:${sleep},${sessions},${readiness},${activity},${stress},${workouts}`;
  const replyMarkup = {
    inline_keyboard: [[{ text: "Details", callback_data: callbackData }]],
  };

  /* v8 ignore next 3 -- fire-and-forget: sendTelegramMessage never rejects visibly */
  void sendTelegramMessage(chatId, text, replyMarkup).catch((err) => {
    console.error("Failed to send Oura sync notification:", err);
  });
}

async function syncAndNotify(pool: pg.Pool, lookbackDays: number): Promise<void> {
  try {
    const result = await runOuraSync(pool, lookbackDays);
    if (result) notifyOuraSync(result);
    /* v8 ignore next 3 -- background sync: errors already recorded in oura_sync_runs */
  } catch (err) {
    notifyError("Oura sync", err);
  }
}

export function startOuraSyncTimer(pool: pg.Pool): NodeJS.Timeout | null {
  if (!config.oura.accessToken) return null;
  void syncAndNotify(pool, 30);
  /* v8 ignore next 3 — interval callback body is not testable in unit tests */
  return setInterval(() => {
    void syncAndNotify(pool, config.oura.syncLookbackDays);
  }, config.oura.syncIntervalMinutes * 60_000);
}
