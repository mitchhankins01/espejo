import type pg from "pg";
import { config } from "../config.js";
import { getOuraSummaryByDay } from "../db/queries.js";

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function buildOuraContextPrompt(pool: pg.Pool): Promise<string> {
  if (!config.oura.accessToken) return "";
  const today = todayInTimezone();
  const summary = await getOuraSummaryByDay(pool, today);
  if (!summary) return "";
  return `Oura Ring biometrics:\nToday: Sleep ${summary.sleep_score ?? "n/a"} | Readiness ${summary.readiness_score ?? "n/a"} | Activity ${summary.activity_score ?? "n/a"} | HRV ${summary.average_hrv ?? "n/a"}ms | ${summary.steps ?? "n/a"} steps | Stress: ${summary.stress ?? "n/a"}`;
}
