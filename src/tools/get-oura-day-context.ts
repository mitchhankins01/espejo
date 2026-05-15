import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { getOuraDayContext } from "../db/queries/oura.js";
import { todayInTimezone } from "../utils/dates.js";

function formatHhmm(ts: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ts);
}

export async function handleGetOuraDayContext(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_oura_day_context", input);
  const day = params.date ?? todayInTimezone();
  const ctx = await getOuraDayContext(pool, day);

  const sections: string[] = [];

  sections.push(`Oura day context for ${day}:`);

  sections.push(`\nTags (${ctx.tags.length}):`);
  if (ctx.tags.length === 0) {
    sections.push("  (none)");
  } else {
    for (const tag of ctx.tags) {
      const label = tag.custom_name ?? tag.tag_type_code ?? "(untagged)";
      const comment = tag.comment ? ` — ${tag.comment}` : "";
      sections.push(`  ${formatHhmm(tag.start_time, config.timezone)} ${label}${comment}`);
    }
  }

  sections.push(`\nSessions (${ctx.sessions.length}):`);
  if (ctx.sessions.length === 0) {
    sections.push("  (none)");
  } else {
    for (const s of ctx.sessions) {
      const mood = s.mood ? ` (${s.mood})` : "";
      sections.push(`  ${formatHhmm(s.start_time, config.timezone)} ${s.type ?? "session"}${mood}`);
    }
  }

  sections.push("\nOptimal bedtime:");
  if (!ctx.sleep_time) {
    sections.push("  (no recommendation)");
  } else {
    const rec = ctx.sleep_time.recommendation ?? "(none)";
    const bedtimeJson = ctx.sleep_time.optimal_bedtime
      ? JSON.stringify(ctx.sleep_time.optimal_bedtime)
      : "(none)";
    sections.push(`  recommendation: ${rec}`);
    sections.push(`  bedtime window: ${bedtimeJson}`);
  }

  return sections.join("\n");
}
