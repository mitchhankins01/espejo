/**
 * Import Kindle vocabulary lookups into books/lookups.jsonl.
 *
 * Usage:
 *   pnpm import-lookups
 *   pnpm import-lookups --source=/Volumes/Kindle/system/vocabulary/vocab.db
 *   KINDLE_VOCAB_DB=/path/to/vocab.db pnpm import-lookups
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendLookups,
  readLookups,
  type Lookup,
} from "./book/lookups.js";

const DEFAULT_KINDLE_PATH = "/Volumes/NO NAME/system/vocabulary/vocab.db";

function parseArgs(): { source: string } {
  const sourceArg = process.argv.find((a) => a.startsWith("--source="));
  const source = sourceArg
    ? sourceArg.slice("--source=".length)
    : process.env.KINDLE_VOCAB_DB ?? DEFAULT_KINDLE_PATH;
  return { source };
}

function tomoNumberFromTitle(title: string): number | null {
  const m = title.match(/Tomo\s+0*(\d+)/i);
  return m ? Number(m[1]) : null;
}

interface Row {
  word: string;
  stem: string;
  lang: string;
  category: number;
  usage: string | null;
  lookup_ts: number;
  book_title: string;
}

async function main(): Promise<void> {
  const { source } = parseArgs();
  if (!existsSync(source)) {
    console.error(`[import-lookups] vocab.db not found at ${source}`);
    console.error(
      "  Plug in the Kindle and mount it, or pass --source=/path/to/vocab.db"
    );
    process.exit(1);
  }

  const tmp = join(tmpdir(), `kindle-vocab-${Date.now()}.db`);
  copyFileSync(source, tmp);

  let rows: Row[] = [];
  try {
    const db = new Database(tmp, { readonly: true });
    rows = db
      .prepare(
        `SELECT w.word       AS word,
                w.stem       AS stem,
                w.lang       AS lang,
                w.category   AS category,
                l.usage      AS usage,
                l.timestamp  AS lookup_ts,
                b.title      AS book_title
           FROM LOOKUPS l
           JOIN WORDS     w ON w.id = l.word_key
           JOIN BOOK_INFO b ON b.id = l.book_key
          ORDER BY l.timestamp ASC`
      )
      .all() as Row[];
    db.close();
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  const existing = await readLookups();
  const existingKey = new Set(
    existing.map((e) => `${e.word}|${e.looked_up_at}`)
  );
  const now = new Date().toISOString();

  const fresh: Lookup[] = [];
  for (const r of rows) {
    const looked_up_at = new Date(r.lookup_ts).toISOString();
    const key = `${r.word}|${looked_up_at}`;
    if (existingKey.has(key)) continue;
    fresh.push({
      word: r.word,
      stem: r.stem,
      lang: r.lang,
      usage: (r.usage ?? "").trim(),
      book_title: r.book_title,
      tomo_n: tomoNumberFromTitle(r.book_title),
      category: r.category,
      looked_up_at,
      imported_at: now,
    });
  }

  await appendLookups(fresh);

  console.log(
    `[import-lookups] ${fresh.length} new, ${existing.length + fresh.length} total in ${existing.length > 0 || fresh.length > 0 ? "books/lookups.jsonl" : "(nothing yet)"}`
  );

  if (fresh.length > 0) {
    const bySource = new Map<string, number>();
    for (const l of fresh) {
      const k =
        l.tomo_n != null ? `tomo ${l.tomo_n}` : `(other) ${l.book_title}`;
      bySource.set(k, (bySource.get(k) ?? 0) + 1);
    }
    console.log("  new by source:");
    for (const [k, v] of [...bySource.entries()].sort()) {
      console.log(`    ${k}: ${v}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
