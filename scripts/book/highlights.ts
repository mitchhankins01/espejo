import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";

export const HIGHLIGHTS_PATH = "books/highlights.jsonl";

export interface Highlight {
  text: string;
  tomo_n: number;
  book_title: string;
  location: string;
  highlighted_at: string;
  imported_at: string;
}

export async function readHighlights(): Promise<Highlight[]> {
  if (!existsSync(HIGHLIGHTS_PATH)) return [];
  const raw = await readFile(HIGHLIGHTS_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Highlight);
}

export async function appendHighlights(rows: Highlight[]): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(HIGHLIGHTS_PATH, body, "utf-8");
}

export function recentHighlights(all: Highlight[], n: number): Highlight[] {
  const sorted = [...all].sort((a, b) =>
    b.highlighted_at.localeCompare(a.highlighted_at)
  );
  return sorted.slice(0, n);
}

export function formatHighlightsForWriter(recent: Highlight[]): string {
  if (recent.length === 0) return "";
  const bullets = recent
    .map((h) => {
      const truncated =
        h.text.length > 140 ? h.text.slice(0, 137) + "..." : h.text;
      return `- "${truncated}" — tomo ${h.tomo_n}`;
    })
    .join("\n");
  return [
    "# Reader grammar / conjugation uncertainties",
    "Sentences the reader highlighted on Kindle while reading prior tomos — by convention, highlights mark conjugations or verb forms he wasn't sure about (the verb was familiar, the form wasn't). Don't quote these back. Use the same structures again in clean natural prose so the pattern locks in through repetition. Don't gloss them, don't draw attention to them.",
    "",
    bullets,
  ].join("\n");
}
