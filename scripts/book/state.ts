import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

const HISTORY_PATH = "books/history.json";

export type TomoDomain =
  | "neuroscience"
  | "psychology"
  | "physics"
  | "psychedelics"
  | "robotics"
  | "ai"
  | "technology"
  | "none";

export interface TomoRecord {
  n: number;
  title: string;
  format: "fiction" | "essay";
  domain: TomoDomain;
  topic: string;
  source_uuids: string[];
  date: string;
  word_count: number;
  series_seed?: boolean;
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

export function nextTomoNumber(h: TomoRecord[]): number {
  if (h.length === 0) return 1;
  return Math.max(...h.map((r) => r.n)) + 1;
}

export function recentSourceUuids(h: TomoRecord[], n = 30): Set<string> {
  const recent = h.slice(-n);
  return new Set(recent.flatMap((r) => r.source_uuids));
}

export interface TomoSummary {
  n: number;
  title: string;
  topic: string;
  format: "fiction" | "essay";
  domain: string;
}

export function recentTomoSummaries(h: TomoRecord[], n = 30): TomoSummary[] {
  return h.slice(-n).map((r) => ({
    n: r.n,
    title: r.title,
    topic: r.topic,
    format: r.format,
    domain: r.domain,
  }));
}
