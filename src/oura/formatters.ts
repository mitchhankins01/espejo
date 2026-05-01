import type { OuraSummaryRow } from "../db/queries.js";

export function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "n/a";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatDay(day: Date | string): string {
  if (typeof day === "string") return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

export function formatOuraSummary(row: OuraSummaryRow): string {
  const lines = [
    `📅 ${formatDay(row.day)}`,
    `Sleep ${row.sleep_score ?? "n/a"} | Readiness ${row.readiness_score ?? "n/a"} | Activity ${row.activity_score ?? "n/a"}`,
    `HRV ${row.average_hrv != null ? Math.round(row.average_hrv) : "n/a"}ms | RHR ${row.lowest_heart_rate ?? "n/a"} | Breath ${row.average_breath != null ? Number(row.average_breath).toFixed(1) : "n/a"}/min`,
    `Steps ${row.steps?.toLocaleString() ?? "n/a"} | Stress ${row.stress ?? "n/a"}`,
    `Sleep: ${fmtDuration(row.sleep_duration_seconds)} (Deep ${fmtDuration(row.deep_sleep_duration_seconds)}, REM ${fmtDuration(row.rem_sleep_duration_seconds)}, Awake ${fmtDuration(row.awake_seconds)}) | Efficiency ${row.efficiency ?? "n/a"}%`,
  ];
  if (row.spo2 != null || row.breathing_disturbance_index != null) {
    lines.push(`SpO2 ${row.spo2 != null ? Number(row.spo2).toFixed(1) : "n/a"}% | Breathing disturbance ${row.breathing_disturbance_index ?? "n/a"}`);
  }
  if (row.resilience_level || row.vascular_age != null) {
    lines.push(`Resilience: ${row.resilience_level ?? "n/a"} | Vascular age: ${row.vascular_age ?? "n/a"}`);
  }
  lines.push(`Workouts: ${row.workout_count}`);
  return lines.join("\n");
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
    ...rows.map((r) => `${formatDay(r.day)} — Sleep ${r.sleep_score ?? "-"}, Ready ${r.readiness_score ?? "-"}, Activity ${r.activity_score ?? "-"}, Steps ${r.steps ?? "-"}, Stress ${r.stress ?? "-"}, Eff ${r.efficiency ?? "-"}%`),
  ].join("\n");
}
