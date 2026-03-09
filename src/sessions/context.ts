import type pg from "pg";
import { getTemplateBySlug, getOuraSummaryByDay, getOuraWeeklyRows, getEntriesByDateRange } from "../db/queries.js";
import { todayInTimezone } from "../utils/dates.js";
import { fmtDuration } from "../oura/formatters.js";
import type { OuraSummaryRow } from "../db/queries/oura.js";

// ============================================================================
// Session context builders for morning/evening journaling
// ============================================================================

export interface SessionContext {
  template: {
    body: string;
    system_prompt: string | null;
  };
  context: {
    oura?: string;
    entries_summary?: string;
    oura_week?: string;
  };
  date: string;
}

function formatOuraOneLiner(row: OuraSummaryRow): string {
  const parts = [
    `Sleep ${row.sleep_score ?? "n/a"}`,
    `Readiness ${row.readiness_score ?? "n/a"}`,
    `Activity ${row.activity_score ?? "n/a"}`,
    `HRV ${row.average_hrv != null ? Math.round(row.average_hrv) : "n/a"}ms`,
    `${row.steps?.toLocaleString() ?? "n/a"} steps`,
    `Stress: ${row.stress ?? "n/a"}`,
  ];
  const lines = [`Oura: ${parts.join(" | ")}`];
  if (row.sleep_duration_seconds) {
    lines.push(
      `Sleep: ${fmtDuration(row.sleep_duration_seconds)} (efficiency ${row.efficiency ?? "n/a"}%) | Deep ${fmtDuration(row.deep_sleep_duration_seconds)} | REM ${fmtDuration(row.rem_sleep_duration_seconds)}`
    );
  }
  return lines.join("\n");
}

function truncateEntryText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

export async function buildMorningContext(
  pool: pg.Pool,
  date?: string
): Promise<SessionContext> {
  const targetDate = date ?? todayInTimezone();

  const [template, ouraRow] = await Promise.all([
    getTemplateBySlug(pool, "morning"),
    getOuraSummaryByDay(pool, targetDate),
  ]);

  if (!template) {
    throw new Error("Morning template not found. Create an entry_template with slug 'morning'.");
  }

  return {
    template: {
      body: template.body,
      system_prompt: template.system_prompt,
    },
    context: {
      oura: ouraRow ? formatOuraOneLiner(ouraRow) : undefined,
    },
    date: targetDate,
  };
}

export async function buildEveningContext(
  pool: pg.Pool,
  date?: string
): Promise<SessionContext> {
  const targetDate = date ?? todayInTimezone();

  // Compute 7-day range ending on targetDate
  const endDate = new Date(targetDate + "T23:59:59Z");
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6);
  const startStr = startDate.toISOString().slice(0, 10);

  const [template, weeklyOura, recentEntries] = await Promise.all([
    getTemplateBySlug(pool, "evening"),
    getOuraWeeklyRows(pool, targetDate),
    getEntriesByDateRange(pool, startStr, targetDate, 50),
  ]);

  if (!template) {
    throw new Error("Evening template not found. Create an entry_template with slug 'evening'.");
  }

  // Truncate entries for context (prevent 18k+ token injection)
  const entriesSummary = recentEntries.map((e) => {
    const dateStr = e.created_at.toISOString().slice(0, 10);
    const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
    return `${dateStr}${tags}: ${truncateEntryText(e.text)}`;
  }).join("\n");

  // Format weekly Oura as compact lines
  const ouraWeek = weeklyOura.map((row) => {
    const day = typeof row.day === "string" ? row.day : (row.day as Date).toISOString().slice(0, 10);
    return `${day}: Sleep ${row.sleep_score ?? "-"} | Readiness ${row.readiness_score ?? "-"} | HRV ${row.average_hrv != null ? Math.round(row.average_hrv) : "-"} | Steps ${row.steps ?? "-"}`;
  }).join("\n");

  return {
    template: {
      body: template.body,
      system_prompt: template.system_prompt,
    },
    context: {
      entries_summary: entriesSummary || undefined,
      oura_week: ouraWeek || undefined,
    },
    date: targetDate,
  };
}
