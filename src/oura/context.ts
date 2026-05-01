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
      `Sleep: ${fmtDuration(summary.sleep_duration_seconds)} (efficiency ${summary.efficiency ?? "n/a"}%) | Deep ${fmtDuration(summary.deep_sleep_duration_seconds)} | REM ${fmtDuration(summary.rem_sleep_duration_seconds)} | RHR ${summary.lowest_heart_rate ?? "n/a"} | Breath ${summary.average_breath != null ? Number(summary.average_breath).toFixed(1) : "n/a"}/min`
    );
  }

  if (summary.spo2 != null || summary.breathing_disturbance_index != null) {
    lines.push(
      `SpO2 ${summary.spo2 != null ? Number(summary.spo2).toFixed(1) : "n/a"}% | Breathing disturbance ${summary.breathing_disturbance_index ?? "n/a"}`
    );
  }

  if (summary.resilience_level || summary.vascular_age != null) {
    lines.push(
      `Resilience: ${summary.resilience_level ?? "n/a"} | Vascular age: ${summary.vascular_age ?? "n/a"}`
    );
  }

  return lines.join("\n");
}
