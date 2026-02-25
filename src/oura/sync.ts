import type pg from "pg";
import { config } from "../config.js";
import {
  completeOuraSyncRun,
  getOuraSummaryByDay,
  getOuraTrendMetric,
  type OuraTrendMetric,
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

function formatUpdatedDataSummary(counts: OuraSyncResult["counts"]): string {
  const datasets: Array<[string, number]> = [
    ["sleep", counts.sleep],
    ["sessions", counts.sessions],
    ["readiness", counts.readiness],
    ["activity", counts.activity],
    ["stress", counts.stress],
    ["workouts", counts.workouts],
  ];

  const updated = datasets
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);

  return updated.length > 0 ? updated.join(", ") : "no data changes";
}

function getDelta(points: Array<{ day: Date; value: number }>): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1]?.value;
  const previous = points[points.length - 2]?.value;
  if (!Number.isFinite(latest) || !Number.isFinite(previous)) return null;
  return latest - previous;
}

function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)}m`;
}

function deriveMetricHints(counts: OuraSyncResult["counts"]): OuraTrendMetric[] {
  const metrics: OuraTrendMetric[] = [];
  if (counts.stress > 0) metrics.push("stress");
  if (counts.sleep > 0 || counts.sessions > 0) metrics.push("sleep_duration", "hrv");
  if (counts.readiness > 0) metrics.push("readiness");
  if (counts.activity > 0) metrics.push("steps");
  return [...new Set(metrics)];
}

function insightFromDelta(metric: OuraTrendMetric, delta: number): string | null {
  if (metric === "stress" && Math.abs(delta) >= 1800) {
    if (delta > 0) {
      return `Stress is up ${formatMinutes(delta)} vs yesterday. Keep today lighter and add a recovery block.`;
    }
    return `Stress is down ${formatMinutes(Math.abs(delta))} vs yesterday. Recovery trend is improving - keep this pace.`;
  }

  if (metric === "sleep_duration" && Math.abs(delta) >= 1800) {
    if (delta < 0) {
      return `Sleep dropped ${formatMinutes(Math.abs(delta))} vs yesterday. Aim for an earlier wind-down tonight.`;
    }
    return `Sleep increased ${formatMinutes(delta)} vs yesterday. Keep the routine that helped.`;
  }

  if (metric === "hrv" && Math.abs(delta) >= 5) {
    if (delta < 0) {
      return `HRV is down ${Math.round(Math.abs(delta))}ms vs yesterday. Favor low-intensity training and recovery today.`;
    }
    return `HRV is up ${Math.round(delta)}ms vs yesterday. Recovery looks better today.`;
  }

  if (metric === "readiness" && Math.abs(delta) >= 5) {
    if (delta < 0) {
      return `Readiness is down ${Math.round(Math.abs(delta))} points vs yesterday. Keep effort moderate and prioritize rest.`;
    }
    return `Readiness is up ${Math.round(delta)} points vs yesterday. Good window for focused work or training.`;
  }

  if (metric === "steps" && Math.abs(delta) >= 2000) {
    if (delta < 0) {
      return `Steps are down ${Math.round(Math.abs(delta))} vs yesterday. A 20-minute walk can close most of the gap.`;
    }
    return `Steps are up ${Math.round(delta)} vs yesterday. Activity momentum is strong - keep it consistent.`;
  }

  return null;
}

export async function buildOuraSyncInsight(pool: pg.Pool, result: OuraSyncResult): Promise<string | null> {
  const metrics = deriveMetricHints(result.counts);

  for (const metric of metrics) {
    try {
      const points = await getOuraTrendMetric(pool, metric, 2);
      const delta = getDelta(points);
      if (delta == null) continue;
      const insight = insightFromDelta(metric, delta);
      if (insight) return insight;
      /* v8 ignore next 3 -- best-effort notification enrichment */
    } catch {
      continue;
    }
  }

  // Fallback to single-day actionable guidance when trend deltas are not available.
  const today = await getOuraSummaryByDay(pool, todayInTimezone());
  const yesterday = today ? null : await getOuraSummaryByDay(pool, daysAgoInTimezone(1));
  const snapshot = today ?? yesterday;
  if (!snapshot) return null;

  if (snapshot.sleep_duration_seconds != null && snapshot.sleep_duration_seconds < 23_400) {
    return "Sleep is under 6.5h. Protect tonight's bedtime to avoid carrying fatigue into tomorrow.";
  }
  if (snapshot.readiness_score != null && snapshot.readiness_score < 70) {
    return `Readiness is ${snapshot.readiness_score}. Keep load light and prioritize recovery today.`;
  }
  if (snapshot.steps != null && snapshot.steps < 6000) {
    return `Steps are ${snapshot.steps}. Add one extra walk to lift activity without overloading recovery.`;
  }
  if (
    snapshot.sleep_duration_seconds != null &&
    snapshot.sleep_duration_seconds >= 25_200 &&
    snapshot.readiness_score != null &&
    snapshot.readiness_score >= 80
  ) {
    return `Recovery looks strong (sleep ${formatMinutes(snapshot.sleep_duration_seconds)}, readiness ${snapshot.readiness_score}). Good day for focused effort.`;
  }

  return null;
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

let lastSentInsight: string | null = null;

export function _resetLastSentInsight(): void {
  lastSentInsight = null;
}

export function notifyOuraSync(result: OuraSyncResult, insight: string | null = null): void {
  const chatId = config.telegram.allowedChatId;
  const token = config.telegram.botToken;
  if (!token || !chatId) return;
  if (!insight) return;
  if (insight === lastSentInsight) return;

  lastSentInsight = insight;
  const updated = formatUpdatedDataSummary(result.counts);
  const text = `Oura sync insight: ${insight}\nUpdated: ${updated}`;
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
    if (result) {
      const insight = await buildOuraSyncInsight(pool, result);
      notifyOuraSync(result, insight);
    }
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
