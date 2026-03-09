import { config } from "../../config.js";
import { pool } from "../../db/client.js";
import {
  getLastCostNotificationTime,
  getTotalApiCostSince,
  insertCostNotification,
} from "../../db/queries.js";
import { COST_NOTIFICATION_INTERVAL_HOURS } from "./constants.js";

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rates = config.apiRates[model];
  /* v8 ignore next -- defensive: all known models have rates */
  if (!rates) return 0;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

export function formatUsd(value: number): string {
  if (value >= 0.1) return value.toFixed(2);
  return value.toFixed(3);
}

export async function maybeBuildCostActivityNote(chatId: string): Promise<string | null> {
  const now = new Date();
  const lastNotifiedAt = await getLastCostNotificationTime(pool, chatId);
  const intervalMs = COST_NOTIFICATION_INTERVAL_HOURS * 60 * 60 * 1000;

  if (lastNotifiedAt && now.getTime() - lastNotifiedAt.getTime() < intervalMs) {
    return null;
  }

  const windowStart = lastNotifiedAt ?? new Date(now.getTime() - intervalMs);
  const totalCost = await getTotalApiCostSince(pool, windowStart, now);
  if (totalCost <= 0) return null;

  await insertCostNotification(pool, {
    chatId,
    windowStart,
    windowEnd: now,
    costUsd: totalCost,
  });

  return `cost ~$${formatUsd(totalCost)} since ${lastNotifiedAt ? "last note" : "last 12h"}`;
}
