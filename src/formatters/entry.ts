import type { EntryRow } from "../db/queries.js";

/**
 * Format a full entry for human-readable MCP output.
 */
export function formatEntry(entry: EntryRow): string {
  const lines: string[] = [];

  // Date header with location
  const date = new Date(entry.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const locationParts: string[] = [];
  if (entry.city) locationParts.push(entry.city);
  if (entry.country) locationParts.push(entry.country);
  const locationStr = locationParts.length > 0 ? ` \u2014 ${locationParts.join(", ")}` : "";
  lines.push(`\uD83D\uDCC5 ${dateStr}${locationStr}`);

  // Tags
  if (entry.tags.length > 0) {
    lines.push(`\uD83C\uDFF7\uFE0F ${entry.tags.join(", ")}`);
  }

  // Starred
  if (entry.starred) {
    lines.push("\u2B50 Starred");
  }

  // Template
  if (entry.template_name) {
    lines.push(`\uD83D\uDCDD Template: ${entry.template_name}`);
  }

  lines.push("");

  // Text
  if (entry.text) {
    lines.push(entry.text);
  }

  lines.push("");
  lines.push("---");

  // Footer: weather + location detail
  const footerParts: string[] = [];
  if (entry.weather_conditions || entry.temperature !== null) {
    const weatherBits: string[] = [];
    if (entry.weather_conditions) weatherBits.push(entry.weather_conditions);
    if (entry.temperature !== null) weatherBits.push(`${entry.temperature}\u00B0C`);
    footerParts.push(`\u2601\uFE0F ${weatherBits.join(", ")}`);
  }
  if (entry.place_name) {
    footerParts.push(`\uD83D\uDCCD ${entry.place_name}`);
  }
  if (footerParts.length > 0) {
    lines.push(footerParts.join(" | "));
  }

  // Activity
  if (entry.user_activity || entry.step_count !== null) {
    const actParts: string[] = [];
    if (entry.user_activity) actParts.push(entry.user_activity);
    if (entry.step_count !== null) actParts.push(`${entry.step_count.toLocaleString()} steps`);
    lines.push(`\uD83C\uDFC3 ${actParts.join(", ")}`);
  }

  // Media
  const mediaCounts: string[] = [];
  if (entry.photo_count > 0) mediaCounts.push(`${entry.photo_count} photo${entry.photo_count > 1 ? "s" : ""}`);
  if (entry.video_count > 0) mediaCounts.push(`${entry.video_count} video${entry.video_count > 1 ? "s" : ""}`);
  if (entry.audio_count > 0) mediaCounts.push(`${entry.audio_count} audio`);
  if (mediaCounts.length > 0) {
    lines.push(`\uD83D\uDDBC\uFE0F ${mediaCounts.join(", ")}`);
  }

  // UUID for reference
  lines.push(`\uD83D\uDD11 ${entry.uuid}`);

  return lines.join("\n");
}

/**
 * Format multiple entries as a list.
 */
export function formatEntryList(entries: EntryRow[]): string {
  if (entries.length === 0) {
    return "No entries found.";
  }

  return entries.map((entry) => formatEntry(entry)).join("\n\n" + "=".repeat(60) + "\n\n");
}

/**
 * Calculate word count for an entry.
 */
export function getWordCount(text: string | null): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
