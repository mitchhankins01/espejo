import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

const HISTORY_PATH = "books/history.json";

// "myth" and "fiction" are legacy values present in older history rows. New
// tomos write only "essay" or "flow". Keep the broader union so old rows parse.
export type TomoFormat = "essay" | "flow" | "myth" | "fiction";

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

export function recentSourceUuids(h: TomoRecord[], n = 30): Set<string> {
  const recent = h.slice(-n);
  const out = new Set<string>();
  for (const tomo of recent) {
    for (const u of tomo.source_uuids) out.add(u);
  }
  return out;
}

export interface TomoSummary {
  n: number;
  title: string;
  topic: string;
  format: TomoFormat;
  domain: string;
}

export function recentTomoSummaries(h: TomoRecord[], n = 30): TomoSummary[] {
  return h.slice(-n).map((r) => ({
    n: r.n,
    title: r.title,
    topic: r.topic,
    format: r.format ?? "essay",
    domain: r.domain,
  }));
}
