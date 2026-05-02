/**
 * Import Kindle sentence-level highlights into books/highlights.jsonl.
 *
 * Parses My Clippings.txt from a mounted Kindle, filters to Espejo Tomo books,
 * dedupes rapid-tap repeats on (tomo_n, location, normalized_text).
 *
 * Usage:
 *   pnpm import-highlights
 *   pnpm import-highlights --source="/Volumes/Kindle/documents/My Clippings.txt"
 *   KINDLE_CLIPPINGS_FILE=/path/to/My\ Clippings.txt pnpm import-highlights
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import {
  appendHighlights,
  readHighlights,
  type Highlight,
} from "./book/highlights.js";

const DEFAULT_KINDLE_PATH = "/Volumes/NO NAME/documents/My Clippings.txt";

function parseArgs(): { source: string } {
  const sourceArg = process.argv.find((a) => a.startsWith("--source="));
  const source = sourceArg
    ? sourceArg.slice("--source=".length)
    : process.env.KINDLE_CLIPPINGS_FILE ?? DEFAULT_KINDLE_PATH;
  return { source };
}

function tomoNumberFromTitle(title: string): number | null {
  const m = title.match(/Tomo\s+0*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

interface ParsedClipping {
  title: string;
  location: string;
  highlighted_at: string;
  text: string;
}

function parseClippings(raw: string): ParsedClipping[] {
  const stripped = raw.replace(/^﻿/, "");
  const blocks = stripped
    .split(/={10,}\r?\n?/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const out: ParsedClipping[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.replace(/^﻿/, ""));
    if (lines.length < 3) continue;
    const title = lines[0]?.trim();
    const meta = lines[1]?.trim();
    if (!title || !meta) continue;
    if (!meta.startsWith("- Your Highlight")) continue;

    const locMatch = meta.match(/Location\s+([\d-]+)/);
    const dateMatch = meta.match(/Added on\s+(.+?)\s*$/);
    if (!locMatch || !dateMatch) continue;

    const text = lines.slice(2).join("\n").trim();
    if (!text) continue;

    const parsedDate = new Date(dateMatch[1]);
    if (Number.isNaN(parsedDate.getTime())) continue;

    out.push({
      title,
      location: locMatch[1],
      highlighted_at: parsedDate.toISOString(),
      text,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const { source } = parseArgs();
  if (!existsSync(source)) {
    console.error(`[import-highlights] My Clippings.txt not found at ${source}`);
    console.error(
      "  Plug in the Kindle and mount it, or pass --source=/path/to/My\\ Clippings.txt"
    );
    process.exit(1);
  }

  const raw = await readFile(source, "utf-8");
  const clippings = parseClippings(raw);

  const existing = await readHighlights();
  const existingKey = new Set(
    existing.map((h) => `${h.tomo_n}|${h.location}|${normalizeText(h.text)}`)
  );
  const now = new Date().toISOString();

  const fresh: Highlight[] = [];
  const seenInBatch = new Set<string>();
  for (const c of clippings) {
    const tomo_n = tomoNumberFromTitle(c.title);
    if (tomo_n == null) continue;
    const key = `${tomo_n}|${c.location}|${normalizeText(c.text)}`;
    if (existingKey.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    fresh.push({
      text: c.text,
      tomo_n,
      book_title: c.title,
      location: c.location,
      highlighted_at: c.highlighted_at,
      imported_at: now,
    });
  }

  await appendHighlights(fresh);

  console.log(
    `[import-highlights] ${fresh.length} new, ${existing.length + fresh.length} total in books/highlights.jsonl`
  );

  if (fresh.length > 0) {
    const byTomo = new Map<number, number>();
    for (const h of fresh) {
      byTomo.set(h.tomo_n, (byTomo.get(h.tomo_n) ?? 0) + 1);
    }
    console.log("  new by tomo:");
    for (const [t, v] of [...byTomo.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    tomo ${t}: ${v}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
