import type { OuraSummaryRow } from "../db/queries.js";

function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "n/a";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatOuraSummary(row: OuraSummaryRow): string {
  return [
    `📅 ${row.day.toISOString().slice(0, 10)}`,
    `Sleep ${row.sleep_score ?? "n/a"} | Readiness ${row.readiness_score ?? "n/a"} | Activity ${row.activity_score ?? "n/a"}`,
    `HRV ${row.average_hrv ?? "n/a"}ms | Steps ${row.steps ?? "n/a"} | Stress ${row.stress ?? "n/a"}`,
    `Sleep: ${fmtDuration(row.sleep_duration_seconds)} (Deep ${fmtDuration(row.deep_sleep_duration_seconds)}, REM ${fmtDuration(row.rem_sleep_duration_seconds)}) | Efficiency ${row.efficiency ?? "n/a"}`,
    `Workouts: ${row.workout_count}`,
  ].join("\n");
}

export function formatOuraWeekly(rows: OuraSummaryRow[]): string {
  if (rows.length === 0) return "No Oura data found for the selected week.";
  const avg = (vals: Array<number | null>): string => {
    const f = vals.filter((v): v is number => typeof v === "number");
    if (f.length === 0) return "n/a";
    return (f.reduce((a, b) => a + b, 0) / f.length).toFixed(1);
  };
  const totalSteps = rows.reduce((sum, r) => sum + (r.steps ?? 0), 0);
  const workouts = rows.reduce((sum, r) => sum + r.workout_count, 0);
  return [
    `Last ${rows.length} days:`,
    `Average sleep/readiness/activity: ${avg(rows.map((r) => r.sleep_score))}/${avg(rows.map((r) => r.readiness_score))}/${avg(rows.map((r) => r.activity_score))}`,
    `Average HRV: ${avg(rows.map((r) => r.average_hrv))}ms`,
    `Total steps: ${totalSteps.toLocaleString()} | Workouts: ${workouts}`,
    "",
    ...rows.map((r) => `${r.day.toISOString().slice(0, 10)} — Sleep ${r.sleep_score ?? "-"}, Ready ${r.readiness_score ?? "-"}, Activity ${r.activity_score ?? "-"}, Steps ${r.steps ?? "-"}`),
  ].join("\n");
}
