import type pg from "pg";
import { handleLogWeights } from "../../tools/log-weights.js";
import { insertChatMessage } from "../../db/queries/chat.js";
import { logUsage } from "../../db/queries/usage.js";
import { sendTelegramMessage } from "../client.js";
import { config } from "../../config.js";

const FLOW_NAME = "weight";

interface ParsedWeight {
  weightKg: number;
  date: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function todayInTz(tz: string, base: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

function shiftDate(dateString: string, days: number): string {
  const [y, m, d] = dateString.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dayOfWeekUtc(dateString: string): number {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function resolveDate(token: string, tz: string): string | null {
  const todayStr = todayInTz(tz);
  const cleaned = token.toLowerCase().trim().replace(/[.,!?]+$/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  if (cleaned === "today" || cleaned === "hoy") return todayStr;
  if (cleaned === "yesterday" || cleaned === "ayer") return shiftDate(todayStr, -1);

  const lastMatch = /^last\s+(sun|mon|tue|wed|thu|fri|sat)(?:day|nesday|sday|urday)?$/.exec(
    cleaned
  );
  const dayMatch = lastMatch
    ? lastMatch[0].replace(/^last\s+/, "")
    : cleaned;
  const fullName = Object.keys(WEEKDAYS).find((name) =>
    name.startsWith(dayMatch.slice(0, 3))
  );
  if (fullName) {
    const target = WEEKDAYS[fullName];
    const todayDow = dayOfWeekUtc(todayStr);
    let diff = todayDow - target;
    if (diff <= 0) diff += 7;
    return shiftDate(todayStr, -diff);
  }

  const ago = /^(\d+)\s+days?\s+ago$/.exec(cleaned);
  if (ago) {
    return shiftDate(todayStr, -Number(ago[1]));
  }
  return null;
}

export function parseWeightSlashArgs(argText: string, tz: string): ParsedWeight | string {
  const trimmed = argText.trim();
  const valueMatch = /^(-?\d+(?:[.,]\d+)?)/.exec(trimmed);
  if (!valueMatch) {
    return "Usage: /weight 78.2 [today|yesterday|YYYY-MM-DD|last monday|3 days ago]";
  }
  const weightKg = Number(valueMatch[1].replace(",", "."));
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    return "Weight must be a positive number in kg.";
  }

  const rest = trimmed.slice(valueMatch[0].length).trim();
  if (rest.length === 0) {
    return { weightKg, date: todayInTz(tz) };
  }
  const date = resolveDate(rest, tz);
  if (!date) {
    return `Couldn't resolve date "${rest}". Use today/yesterday/YYYY-MM-DD/last monday/3 days ago.`;
  }
  return { weightKg, date };
}

export async function runWeightSlashFlow(params: {
  pool: pg.Pool;
  chatId: string;
  externalMessageId: string | null;
  argText: string;
  rawText: string;
}): Promise<void> {
  const { pool, chatId, externalMessageId, argText, rawText } = params;
  const startedAt = Date.now();

  await insertChatMessage(pool, {
    chatId,
    externalMessageId,
    role: "user",
    content: rawText,
    flow: FLOW_NAME,
  });

  const parsed = parseWeightSlashArgs(argText, config.timezone);
  if (typeof parsed === "string") {
    await sendTelegramMessage(chatId, parsed);
    await insertChatMessage(pool, {
      chatId,
      externalMessageId: null,
      role: "assistant",
      content: parsed,
      flow: FLOW_NAME,
    });
    return;
  }

  let reply: string;
  try {
    await handleLogWeights(pool, {
      measurements: [{ date: parsed.date, weight_kg: parsed.weightKg }],
    });
    reply = `Logged ${parsed.weightKg} kg for ${parsed.date}.`;
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "log_weights",
      actor: chatId,
      args: parsed,
      ok: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply = `Failed to log weight: ${message}`;
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "log_weights",
      actor: chatId,
      args: parsed,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
  }
  await sendTelegramMessage(chatId, reply);
  await insertChatMessage(pool, {
    chatId,
    externalMessageId: null,
    role: "assistant",
    content: reply,
    flow: FLOW_NAME,
  });
}
