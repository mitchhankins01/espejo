/**
 * One-shot Haiku gloss-fill for every vocab_reviews row where gloss IS NULL.
 * Idempotent — already-glossed rows are skipped at the query level.
 *
 * Usage:
 *   pnpm backfill:glosses
 *   pnpm backfill:glosses --limit=50
 */

import { pool } from "../src/db/client.js";
import { fillMissingGlosses } from "../src/fsrs/gloss.js";

function parseLimit(): number {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return 1000;
  const v = Number(arg.slice("--limit=".length));
  if (!Number.isFinite(v) || v < 1) throw new Error(`bad --limit: ${arg}`);
  return v;
}

async function main(): Promise<void> {
  const limit = parseLimit();
  console.log(`[backfill-glosses] filling up to ${limit} rows`);
  const written = await fillMissingGlosses(pool, limit);
  console.log(`[backfill-glosses] wrote ${written} gloss(es)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => undefined));
