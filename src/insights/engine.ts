import type pg from "pg";
import { config } from "../config.js";
import {
  countInsightsNotifiedToday,
  findStaleTodos,
  findTemporalEchoes,
  getEntriesByDateRange,
  getOuraSummaryByDay,
  insightHashExists,
  insertInsight,
  markInsightNotified,
} from "../db/queries.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { notifyError } from "../telegram/notify.js";
import { todayInTimezone } from "../utils/dates.js";
import {
  analyzeBiometricCorrelations,
  analyzeStaleTodos,
  analyzeTemporalEchoes,
  detectBiometricOutliers,
  type InsightCandidate,
} from "./analyzers.js";
import { formatInsightNotification } from "./formatters.js";

const INSIGHT_LOCK_KEY = 9152202;

// ============================================================================
// Result type
// ============================================================================

export interface InsightEngineResult {
  candidatesGenerated: number;
  insightsNotified: number;
  skippedDedup: number;
  skippedCap: number;
}

// ============================================================================
// Engine
// ============================================================================

export async function runInsightEngine(pool: pg.Pool): Promise<InsightEngineResult | null> {
  const lock = await pool.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [INSIGHT_LOCK_KEY]
  );
  if (!lock.rows[0]?.ok) return null;

  try {
    const today = todayInTimezone();
    const [year, month, day] = today.split("-").map(Number);
    const timezone = config.timezone;

    const notifiedToday = await countInsightsNotifiedToday(pool, timezone);
    const remainingCap = config.insights.maxPerDay - notifiedToday;
    if (remainingCap <= 0) {
      return { candidatesGenerated: 0, insightsNotified: 0, skippedDedup: 0, skippedCap: 0 };
    }

    const candidates: InsightCandidate[] = [];

    // 1. Temporal echoes
    const echoes = await findTemporalEchoes(
      pool, month, day, year,
      config.insights.temporalEchoThreshold,
      timezone, 10
    );
    candidates.push(...analyzeTemporalEchoes(echoes));

    // 2. Biometric-journal correlations
    const summary = await getOuraSummaryByDay(pool, today);
    if (summary) {
      const outliers = detectBiometricOutliers(summary);
      if (outliers.length > 0) {
        const entries = await getEntriesByDateRange(pool, today, today, 5);
        const nearbyEntries = entries
          .filter((e) => e.text)
          .slice(0, 3)
          .map((e) => ({
            uuid: e.uuid,
            preview: e.text.slice(0, 200),
            created_at: e.created_at,
          }));
        candidates.push(...analyzeBiometricCorrelations(today, outliers, nearbyEntries));
      }
    }

    // 3. Stale todos
    const staleTodos = await findStaleTodos(pool, config.insights.staleTodoDays, 5);
    candidates.push(...analyzeStaleTodos(staleTodos));

    // Sort by relevance and process
    candidates.sort((a, b) => b.relevance - a.relevance);

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
          console.error("Failed to send insight notification:", err);
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

// ============================================================================
// Timer
// ============================================================================

async function runAndNotify(pool: pg.Pool): Promise<void> {
  try {
    await runInsightEngine(pool);
    /* v8 ignore next 3 -- background engine: errors are notified */
  } catch (err) {
    notifyError("Insight engine", err);
  }
}

export function startInsightTimer(pool: pg.Pool): NodeJS.Timeout | null {
  if (!config.telegram.botToken || !config.telegram.allowedChatId) return null;

  void runAndNotify(pool);
  /* v8 ignore next 3 -- interval callback body is not testable in unit tests */
  return setInterval(() => {
    void runAndNotify(pool);
  }, config.insights.intervalHours * 3_600_000);
}
