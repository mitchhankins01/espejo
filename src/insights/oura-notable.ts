import type pg from "pg";
import { config } from "../config.js";
import {
  countInsightsNotifiedToday,
  getOuraTrendMetric,
  getOuraSummaryByDay,
  insightHashExists,
  insertInsight,
  markInsightNotified,
  type OuraTrendMetric,
} from "../db/queries.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { daysAgoInTimezone } from "../utils/dates.js";
import {
  analyzeOuraNotable,
  type OuraMetricSeries,
  type OuraStressDay,
  type OuraSleepContributors,
} from "./analyzers.js";
import { formatInsightNotification } from "./formatters.js";
import type { InsightEngineResult } from "./engine.js";

const INSIGHT_LOCK_KEY = 9152202;

const METRIC_CONFIGS: Array<{
  metric: OuraTrendMetric;
  label: string;
  unit?: string;
  higherIsBetter?: boolean;
}> = [
  { metric: "sleep_score", label: "Sleep score" },
  { metric: "readiness", label: "Readiness" },
  { metric: "hrv", label: "HRV", unit: "ms" },
  { metric: "sleep_duration", label: "Sleep duration", unit: "s" },
  { metric: "steps", label: "Steps" },
];

export async function runOuraNotableCheck(pool: pg.Pool): Promise<InsightEngineResult | null> {
  const lock = await pool.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [INSIGHT_LOCK_KEY]
  );
  if (!lock.rows[0]?.ok) return null;

  try {
    const notifiedToday = await countInsightsNotifiedToday(pool, config.timezone);
    const remainingCap = config.insights.maxPerDay - notifiedToday;
    if (remainingCap <= 0) {
      return { candidatesGenerated: 0, insightsNotified: 0, skippedDedup: 0, skippedCap: 0 };
    }

    // Fetch 30 days of each metric in parallel
    const trendResults = await Promise.all(
      METRIC_CONFIGS.map((cfg) => getOuraTrendMetric(pool, cfg.metric, 30))
    );

    const metricSeries: OuraMetricSeries[] = METRIC_CONFIGS.map((cfg, i) => ({
      metric: cfg.metric,
      label: cfg.label,
      values: trendResults[i].map((p) => p.value),
      unit: cfg.unit,
      higherIsBetter: cfg.higherIsBetter,
    }));

    // Fetch stress day summaries for last 7 days
    const stressDays: OuraStressDay[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = daysAgoInTimezone(i);
      const summary = await getOuraSummaryByDay(pool, day);
      if (summary) {
        stressDays.push({ day_summary: summary.stress });
      }
    }

    // Fetch sleep contributors for last 3 days
    const sleepContributors: OuraSleepContributors[] = [];
    for (let i = 2; i >= 0; i--) {
      const day = daysAgoInTimezone(i);
      const result = await pool.query<{ day: string; contributors: Record<string, number> | null }>(
        `SELECT day::text, contributors FROM oura_daily_sleep WHERE day = $1`,
        [day]
      );
      if (result.rows[0]) {
        sleepContributors.push(result.rows[0]);
      }
    }

    const candidates = analyzeOuraNotable(metricSeries, stressDays, sleepContributors);

    let insightsNotified = 0;
    let skippedDedup = 0;
    let skippedCap = 0;

    for (const candidate of candidates) {
      if (insightsNotified >= remainingCap) {
        skippedCap++;
        continue;
      }

      const isDupe = await insightHashExists(
        pool,
        candidate.contentHash,
        config.insights.dedupWindowDays
      );
      if (isDupe) {
        skippedDedup++;
        continue;
      }

      const id = await insertInsight(
        pool,
        candidate.type,
        candidate.contentHash,
        candidate.title,
        candidate.body,
        candidate.relevance,
        candidate.metadata
      );

      const chatId = config.telegram.allowedChatId;
      if (chatId) {
        const text = formatInsightNotification(candidate);
        /* v8 ignore next 3 -- fire-and-forget */
        void sendTelegramMessage(chatId, text).catch((err) => {
          console.error("Failed to send oura notable notification:", err);
        });
      }

      await markInsightNotified(pool, id);
      insightsNotified++;
    }

    return {
      candidatesGenerated: candidates.length,
      insightsNotified,
      skippedDedup,
      skippedCap,
    };
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [INSIGHT_LOCK_KEY]);
  }
}
