import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";

export const LOOKUPS_PATH = "books/lookups.jsonl";

export interface Lookup {
  word: string;
  stem: string;
  lang: string;
  usage: string;
  book_title: string;
  tomo_n: number | null;
  category: number;
  looked_up_at: string;
  imported_at: string;
}

export async function readLookups(): Promise<Lookup[]> {
  if (!existsSync(LOOKUPS_PATH)) return [];
  const raw = await readFile(LOOKUPS_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Lookup);
}

export async function appendLookups(rows: Lookup[]): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(LOOKUPS_PATH, body, "utf-8");
}

export function recentLookups(all: Lookup[], n: number): Lookup[] {
  const sorted = [...all].sort((a, b) =>
    b.looked_up_at.localeCompare(a.looked_up_at)
  );
  const seen = new Set<string>();
  const out: Lookup[] = [];
  for (const l of sorted) {
    const key = l.stem.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= n) break;
  }
  return out;
}

export function countLookupsByTomo(all: Lookup[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const l of all) {
    if (l.tomo_n == null) continue;
    counts.set(l.tomo_n, (counts.get(l.tomo_n) ?? 0) + 1);
  }
  return counts;
}

export function formatLookupsForWriter(recent: Lookup[]): string {
  if (recent.length === 0) return "";
  const bullets = recent
    .map((l) => {
      const source = l.tomo_n != null ? `tomo ${l.tomo_n}` : l.book_title;
      const infl =
        l.word.toLowerCase() !== l.stem.toLowerCase() ? ` (${l.word})` : "";
      return `- ${l.stem}${infl} — ${source}`;
    })
    .join("\n");
  return [
    "# Recent reader lookups",
    "Words he looked up on Kindle while reading prior tomos. Reuse naturally where they fit — reinforcement through reuse, not repetition. Avoid stacking equivalently hard new vocabulary in a single paragraph.",
    "",
    bullets,
  ].join("\n");
}
