import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";

export const LOOKUPS_PATH = "books/lookups.jsonl";
export const GRAMMAR_FLAGS_PATH = "books/grammar-flags.jsonl";

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

export interface GrammarFlag {
  stem: string;
  form: string;
  note: string;
  tomo_n: number | null;
  flagged_at: string;
}

export async function readGrammarFlags(): Promise<GrammarFlag[]> {
  if (!existsSync(GRAMMAR_FLAGS_PATH)) return [];
  const raw = await readFile(GRAMMAR_FLAGS_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GrammarFlag);
}

export async function appendGrammarFlags(rows: GrammarFlag[]): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(GRAMMAR_FLAGS_PATH, body, "utf-8");
}

export function recentGrammarFlags(all: GrammarFlag[], n: number): GrammarFlag[] {
  const sorted = [...all].sort((a, b) =>
    b.flagged_at.localeCompare(a.flagged_at)
  );
  const seen = new Set<string>();
  const out: GrammarFlag[] = [];
  for (const f of sorted) {
    const key = `${f.stem.toLowerCase()}|${f.form.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= n) break;
  }
  return out;
}

export function formatGrammarFlagsForWriter(recent: GrammarFlag[]): string {
  if (recent.length === 0) return "";
  const bullets = recent
    .map((f) => {
      const source = f.tomo_n != null ? ` (tomo ${f.tomo_n})` : "";
      const note = f.note ? ` — ${f.note}` : "";
      return `- ${f.form} (de ${f.stem})${source}${note}`;
    })
    .join("\n");
  return [
    "# Reader grammar uncertainties",
    "Conjugations or forms the reader paused on while reading prior tomos — he knew the verb but wasn't sure about the form. Use these structures again in natural prose so the pattern locks in. Don't gloss them, don't draw attention to them, just let them appear.",
    "",
    bullets,
  ].join("\n");
}
