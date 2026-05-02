import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

const HISTORY_PATH = "books/history.json";

export type TomoFormat = "essay" | "myth" | "fiction";

export type TomoDomain =
  | "neuroscience"
  | "cognition"
  | "psychology"
  | "philosophy"
  | "hermeticism"
  | "physics"
  | "psychedelics"
  | "ai"
  | "robotics"
  | "technology"
  | "mythology"
  | "none";

export interface TomoRecord {
  n: number;
  title: string;
  format?: TomoFormat;
  domain: TomoDomain;
  topic: string;
  source_uuids: string[];
  date: string;
  word_count: number;
  word_count_myth?: number;
  word_count_bridge?: number;
  series_seed?: boolean;
  bilingual?: boolean;
  myth_name?: string;
  shared_with_julia?: string;
}

export async function readHistory(): Promise<TomoRecord[]> {
  if (!existsSync(HISTORY_PATH)) return [];
  const raw = await readFile(HISTORY_PATH, "utf-8");
  return JSON.parse(raw) as TomoRecord[];
}

export async function appendHistory(r: TomoRecord): Promise<void> {
  const h = await readHistory();
  h.push(r);
  await writeFile(HISTORY_PATH, JSON.stringify(h, null, 2) + "\n", "utf-8");
}

export async function updateHistory(
  n: number,
  patch: Partial<TomoRecord>
): Promise<void> {
  const h = await readHistory();
  const idx = h.findIndex((r) => r.n === n);
  if (idx < 0) throw new Error(`updateHistory: tomo ${n} not in history`);
  h[idx] = { ...h[idx], ...patch };
  await writeFile(HISTORY_PATH, JSON.stringify(h, null, 2) + "\n", "utf-8");
}

export function nextTomoNumber(h: TomoRecord[]): number {
  if (h.length === 0) return 1;
  return Math.max(...h.map((r) => r.n)) + 1;
}

export function recentSourceUuids(
  h: TomoRecord[],
  fullN = 30,
  mythN = 15
): Set<string> {
  const recent = h.slice(-fullN);
  const out = new Set<string>();
  for (let i = 0; i < recent.length; i++) {
    const tomo = recent[i];
    const isMyth = (tomo.format ?? "essay") === "myth";
    const tomosFromEnd = recent.length - i;
    if (isMyth && tomosFromEnd > mythN) continue;
    for (const u of tomo.source_uuids) out.add(u);
  }
  return out;
}

export function recentMythNames(h: TomoRecord[], n = 8): Set<string> {
  const out = new Set<string>();
  for (const r of h.slice(-n)) {
    if (r.myth_name) out.add(r.myth_name);
  }
  return out;
}

export interface TomoSummary {
  n: number;
  title: string;
  topic: string;
  format: TomoFormat;
  domain: string;
  myth_name?: string;
}

export function recentTomoSummaries(h: TomoRecord[], n = 30): TomoSummary[] {
  return h.slice(-n).map((r) => ({
    n: r.n,
    title: r.title,
    topic: r.topic,
    format: r.format ?? "essay",
    domain: r.domain,
    myth_name: r.myth_name,
  }));
}
