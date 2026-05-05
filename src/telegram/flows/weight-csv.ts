import type pg from "pg";
import { handleLogWeights } from "../../tools/log-weights.js";
import { logUsage } from "../../db/queries/usage.js";
import { fetchTelegramFile } from "../media.js";
import { sendTelegramMessage } from "../client.js";

const RENPHO_HEADER_FRAGMENTS = ["date", "weight"];

export interface ParsedWeightRow {
  date: string;
  weight_kg: number;
}

export function isWeightCsvDocument(params: {
  mimeType?: string;
  fileName?: string;
}): boolean {
  if (params.mimeType?.includes("csv")) return true;
  return Boolean(params.fileName && /\.csv$/i.test(params.fileName));
}

function normalizeDate(raw: string): string | null {
  const m = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/.exec(raw.trim());
  if (!m) return null;
  let year: number;
  let month: number;
  let day: number;
  // RENPHO uses M/D/YY → if first segment is small and last is 2-digit year
  if (m[1].length <= 2 && m[3].length === 2) {
    month = Number(m[1]);
    day = Number(m[2]);
    year = 2000 + Number(m[3]);
  } else if (m[1].length === 4) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    month = Number(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
    if (year < 100) year += 2000;
  }
  if (!month || !day || !year) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function parseRenphoCsv(content: string): ParsedWeightRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const headerCols = header.split(",").map((c) => c.trim());
  const allFragments = RENPHO_HEADER_FRAGMENTS.every((frag) =>
    headerCols.some((col) => col.includes(frag))
  );
  if (!allFragments) return [];

  const dateIdx = headerCols.findIndex((c) => c.includes("date"));
  const weightIdx = headerCols.findIndex((c) => c.includes("weight"));
  if (dateIdx === -1 || weightIdx === -1) return [];

  const out: ParsedWeightRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length <= Math.max(dateIdx, weightIdx)) continue;
    const date = normalizeDate(cols[dateIdx]);
    const weightKg = Number(cols[weightIdx]);
    if (!date || !Number.isFinite(weightKg) || weightKg <= 0) continue;
    // Last write wins on duplicates (RENPHO can have multiple measurements per
    // day) — overwrite by removing prior entries for the same date.
    if (seen.has(date)) {
      const idx = out.findIndex((r) => r.date === date);
      if (idx >= 0) out.splice(idx, 1);
    }
    seen.add(date);
    out.push({ date, weight_kg: weightKg });
  }
  return out;
}

export async function tryRunWeightCsvFlow(params: {
  pool: pg.Pool;
  chatId: string;
  fileId: string;
  fileName?: string;
}): Promise<{ handled: boolean }> {
  const { pool, chatId, fileId, fileName } = params;
  const startedAt = Date.now();
  const { buffer } = await fetchTelegramFile(fileId);
  const content = buffer.toString("utf8");
  const rows = parseRenphoCsv(content);
  if (rows.length === 0) {
    return { handled: false };
  }
  try {
    await handleLogWeights(pool, { measurements: rows });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const reply = `Logged ${rows.length} weights from CSV (${rows[0].date} to ${rows[rows.length - 1].date}).`;
    await sendTelegramMessage(chatId, reply);
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "weight_csv",
      actor: chatId,
      args: { rows: rows.length, fileName },
      ok: true,
      durationMs: Date.now() - startedAt,
    });
    return { handled: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramMessage(
      chatId,
      `Couldn't log CSV: ${message}. Use /weight 78.2 [date] manually.`
    );
    await logUsage(pool, {
      source: "telegram",
      surface: "flow",
      action: "weight_csv",
      actor: chatId,
      args: { rows: rows.length, fileName },
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { handled: true };
  }
}
