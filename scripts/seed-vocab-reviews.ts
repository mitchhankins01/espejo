/**
 * One-shot first-run: read books/lookups.jsonl and upsert every row into
 * vocab_reviews. Idempotent — upsertLookup only refreshes sample fields
 * + last_seen_at on conflict, never the FSRS state.
 *
 * Usage:
 *   pnpm seed:vocab
 */

import { pool } from "../src/db/client.js";
import { upsertLookup } from "../src/db/queries/vocab-reviews.js";
import { readLookups } from "./kindle-vocab.js";

async function main(): Promise<void> {
  const rows = await readLookups();
  console.log(`[seed-vocab] read ${rows.length} lookups`);

  let count = 0;
  for (const l of rows) {
    await upsertLookup(pool, {
      stem: l.stem,
      lang: l.lang,
      sampleUsage: l.usage,
      sampleWord: l.word,
      sampleSource: l.book_title,
      lookedUpAt: new Date(l.looked_up_at),
    });
    count += 1;
    if (count % 50 === 0) {
      console.log(`  ${count}/${rows.length}`);
    }
  }

  const total = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM vocab_reviews"
  );
  console.log(`[seed-vocab] done. ${total.rows[0].count} rows in vocab_reviews`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => undefined));
