import type pg from "pg";
import { config } from "../config.js";
import { getEntriesOnThisDay, insertActivityLog, type EntryRow } from "../db/queries.js";
import { sendTelegramMessage } from "../telegram/client.js";
import { notifyError } from "../telegram/notify.js";
import { getAnthropic } from "../telegram/agent/constants.js";
import { todayInTimezone, currentHourInTimezone } from "../utils/dates.js";

const LOCK_KEY = 9152203;
const CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const MAX_ENTRIES = 20;
const MAX_WORDS_PER_ENTRY = 1500;

const SYSTEM_PROMPT = `You are writing an "On This Day" reflection for a personal journal.
You'll receive journal entries from this calendar date across multiple years.

Write a 2-3 paragraph reflection in English that braids two threads:

1. The relational thread — who the user was with, how they were relating, the quality of connection. Name people when the entries do (partner, family, friends, colleagues, strangers). Track recurring people and how those relationships have evolved across years.

2. The growth thread — how the user has changed, matured, or shifted perspective over the years. Notice evolving beliefs, habits, concerns, or ways of showing up. Mark moments of clear personal evolution.

Other guidance:
- Weave the two threads together where they meet (e.g., how relationships shaped growth, or how the user shows up differently with the same people now)
- Notice solitude too, and how it relates to or contrasts with time spent with others
- Use "X years ago" framing naturally (e.g., "Three years ago in Barcelona, you were with…")
- Keep a warm, contemplative tone — like a thoughtful friend, not a therapist

Format for Telegram HTML: use <b>bold</b> for emphasis, plain line breaks.
Keep it under 300 words. Do not list entries — synthesize them.`;

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}

export function formatEntriesForPrompt(entries: EntryRow[], today: Date): string {
  const lines: string[] = [];

  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const entryDate = new Date(entry.created_at);
    const yearsAgo = today.getFullYear() - entryDate.getFullYear();
    const dateLabel = entryDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    lines.push(`--- ${dateLabel} (${yearsAgo} year${yearsAgo !== 1 ? "s" : ""} ago) ---`);

    const locationParts: string[] = [];
    if (entry.city) locationParts.push(entry.city);
    if (entry.country) locationParts.push(entry.country);
    if (locationParts.length > 0) {
      lines.push(`Location: ${locationParts.join(", ")}`);
    }

    if (entry.text) {
      lines.push(truncateWords(entry.text, MAX_WORDS_PER_ENTRY));
    }

    const mediaCounts: string[] = [];
    if (entry.photo_count > 0) mediaCounts.push(`${entry.photo_count} photo${entry.photo_count > 1 ? "s" : ""}`);
    if (entry.video_count > 0) mediaCounts.push(`${entry.video_count} video${entry.video_count > 1 ? "s" : ""}`);
    if (entry.audio_count > 0) mediaCounts.push(`${entry.audio_count} audio`);
    if (mediaCounts.length > 0) {
      lines.push(`[Attachments: ${mediaCounts.join(", ")}]`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function synthesizeReflection(entries: EntryRow[]): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const today = new Date();
  const prompt = formatEntriesForPrompt(entries, today);
  const model = config.anthropic.model;
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function alreadySentToday(pool: pg.Pool, today: string): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM activity_logs
     WHERE created_at::date = $1::date
       AND tool_calls @> '[{"name":"on_this_day"}]'::jsonb`,
    [today]
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

export async function runOnThisDay(pool: pg.Pool): Promise<void> {
  if (!config.onThisDay.enabled) return;
  if (!config.telegram.allowedChatId) return;

  const hour = currentHourInTimezone(config.timezone);
  if (hour !== config.onThisDay.targetHour) return;

  const today = todayInTimezone();
  if (await alreadySentToday(pool, today)) return;

  // Acquire advisory lock
  const lock = await pool.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [LOCK_KEY]
  );
  if (!lock.rows[0]?.ok) return;

  try {
    // Re-check after lock to prevent race
    if (await alreadySentToday(pool, today)) return;

    const [, , monthStr, dayStr] = today.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);

    const entries = await getEntriesOnThisDay(pool, month, day, config.timezone);
    if (entries.length === 0) return;

    const { text } = await synthesizeReflection(entries);

    const header = `<b>📅 On This Day</b>\n\n`;
    await sendTelegramMessage(config.telegram.allowedChatId, header + text);

    // Record activity for dedup (alreadySentToday checks this via tool_calls @> on_this_day)
    await insertActivityLog(pool, {
      chatId: config.telegram.allowedChatId,
      memories: [],
      toolCalls: [{ name: "on_this_day", args: {}, result: "sent", truncated_result: "sent" }],
      costUsd: null,
    });
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

async function runAndNotify(pool: pg.Pool): Promise<void> {
  try {
    await runOnThisDay(pool);
  } catch (err) {
    notifyError("On This Day", err);
  }
}

export function startOnThisDayTimer(pool: pg.Pool): NodeJS.Timeout | null {
  if (!config.onThisDay.enabled) return null;
  void runAndNotify(pool);
  /* v8 ignore next 3 — interval callback body is not testable in unit tests */
  return setInterval(() => {
    void runAndNotify(pool);
  }, CHECK_INTERVAL_MS);
}
