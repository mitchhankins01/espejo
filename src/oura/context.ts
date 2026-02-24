import type pg from "pg";
import { config } from "../config.js";
import { getOuraSummaryByDay } from "../db/queries.js";
import { todayInTimezone } from "../utils/dates.js";
import { fmtDuration } from "./formatters.js";

export async function buildOuraContextPrompt(pool: pg.Pool): Promise<string> {
  if (!config.oura.accessToken) return "";
  const today = todayInTimezone();
  const summary = await getOuraSummaryByDay(pool, today);
  if (!summary) return "";

  const lines = [
    `Oura Ring biometrics:`,
    `Today: Sleep ${summary.sleep_score ?? "n/a"} | Readiness ${summary.readiness_score ?? "n/a"} | Activity ${summary.activity_score ?? "n/a"} | HRV ${summary.average_hrv != null ? Math.round(summary.average_hrv) : "n/a"}ms | ${summary.steps?.toLocaleString() ?? "n/a"} steps | Stress: ${summary.stress ?? "n/a"}`,
  ];

  if (summary.sleep_duration_seconds) {
    lines.push(
      `Sleep: ${fmtDuration(summary.sleep_duration_seconds)} (efficiency ${summary.efficiency ?? "n/a"}%) | Deep ${fmtDuration(summary.deep_sleep_duration_seconds)} | REM ${fmtDuration(summary.rem_sleep_duration_seconds)}`
    );
  }

  return lines.join("\n");
}
