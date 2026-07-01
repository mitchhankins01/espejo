/**
 * Shared store for Kindle vocabulary lookups (books/lookups.jsonl).
 *
 * Used by `scripts/import-lookups.ts` (Kindle vocab.db → JSONL + SRS upserts)
 * and `scripts/seed-vocab-reviews.ts`. Formerly part of the tomo pipeline's
 * writer inputs; the tomo Spanish is no longer tailored to the reader's
 * vocabulary, so this now serves only the SRS flow.
 */
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
