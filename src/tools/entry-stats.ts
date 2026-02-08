import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getEntryStats } from "../db/queries.js";

export async function handleEntryStats(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("entry_stats", input);

  const stats = await getEntryStats(pool, params.date_from, params.date_to);

  if (stats.total_entries === 0) {
    return "No entries found for the specified date range.";
  }

  const lines: string[] = [];

  // Header
  const rangeStr =
    params.date_from || params.date_to
      ? ` (${params.date_from || "start"} to ${params.date_to || "now"})`
      : "";
  lines.push(`\uD83D\uDCCA Journal Statistics${rangeStr}\n`);

  // Overview
  const firstDate = new Date(stats.first_entry).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const lastDate = new Date(stats.last_entry).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  lines.push(`Total entries: ${stats.total_entries.toLocaleString()}`);
  lines.push(`Date range: ${firstDate} \u2014 ${lastDate}`);
  lines.push(
    `Average entries per week: ${stats.avg_entries_per_week}`
  );
  lines.push("");

  // Word counts
  lines.push("\uD83D\uDCDD Word Counts");
  lines.push(`  Total: ${stats.total_word_count.toLocaleString()}`);
  lines.push(`  Average per entry: ${stats.avg_word_count.toLocaleString()}`);
  lines.push("");

  // Streaks
  lines.push("\uD83D\uDD25 Streaks");
  lines.push(`  Longest streak: ${stats.longest_streak_days} days`);
  lines.push(`  Current streak: ${stats.current_streak_days} days`);
  lines.push("");

  // By day of week
  lines.push("\uD83D\uDCC6 Entries by Day of Week");
  for (const [day, count] of Object.entries(stats.entries_by_dow)) {
    const bar = "\u2588".repeat(Math.ceil(count / 2));
    lines.push(`  ${day.padEnd(10)} ${count.toString().padStart(4)} ${bar}`);
  }
  lines.push("");

  // By month
  lines.push("\uD83D\uDCC5 Entries by Month");
  for (const [month, count] of Object.entries(stats.entries_by_month)) {
    const bar = "\u2588".repeat(Math.ceil(count / 2));
    lines.push(`  ${month.padEnd(10)} ${count.toString().padStart(4)} ${bar}`);
  }

  return lines.join("\n");
}
