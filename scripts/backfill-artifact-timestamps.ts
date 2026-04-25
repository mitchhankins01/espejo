/**
 * Backfill knowledge_artifacts.created_at / updated_at from Obsidian frontmatter.
 *
 * One-off correction for rows synced before the parser learned to extract
 * frontmatter timestamps. Reads every obsidian-sourced artifact, fetches the
 * underlying R2 object, parses the frontmatter, and writes the timestamps
 * directly. Does NOT touch embedding, content_hash, body, or version —
 * pure metadata fix. Idempotent; safe to re-run.
 *
 * Usage:
 *   NODE_ENV=production pnpm tsx scripts/backfill-artifact-timestamps.ts
 *   pnpm tsx scripts/backfill-artifact-timestamps.ts                  # dev DB
 */

import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}

import pg from "pg";
import { createClient, getObjectContent } from "../src/storage/r2.js";
import { parseObsidianNote } from "../src/obsidian/parser.js";

const VAULT_BUCKET = "artifacts";

const databaseUrl =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "test"
    ? "postgresql://test:test@localhost:5433/journal_test"
    : "postgresql://dev:dev@localhost:5434/journal_dev");

interface ArtifactRow {
  id: string;
  source_path: string;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const r2 = createClient();

  const start = Date.now();
  let scanned = 0;
  let withTimestamps = 0;
  let updated = 0;
  let downloadErrors = 0;
  let parseErrors = 0;

  try {
    const result = await pool.query<ArtifactRow>(
      `SELECT id, source_path
       FROM knowledge_artifacts
       WHERE source = 'obsidian'
         AND source_path IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY source_path`
    );
    const rows = result.rows;
    console.log(`Backfill: ${rows.length} obsidian artifacts to inspect`);

    for (const row of rows) {
      scanned++;

      let content: string;
      try {
        content = await getObjectContent(r2, VAULT_BUCKET, row.source_path);
      } catch (err) {
        downloadErrors++;
        console.warn(
          `[skip] ${row.source_path}: download failed — ${err instanceof Error ? err.message : "unknown"}`
        );
        continue;
      }

      const parsed = parseObsidianNote(content, row.source_path);
      if (parsed.dateParseErrors.length > 0) {
        parseErrors += parsed.dateParseErrors.length;
        for (const msg of parsed.dateParseErrors) {
          console.warn(`[parse] ${row.source_path}: ${msg}`);
        }
      }

      if (!parsed.createdAt && !parsed.updatedAt) continue;
      withTimestamps++;

      await pool.query(
        `UPDATE knowledge_artifacts
         SET created_at = COALESCE($1, created_at),
             updated_at = COALESCE($2, updated_at)
         WHERE id = $3`,
        [parsed.createdAt ?? null, parsed.updatedAt ?? null, row.id]
      );
      updated++;

      if (updated % 50 === 0) {
        console.log(`  ...${updated} updated so far`);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log("");
    console.log("Summary:");
    console.log(`  scanned:           ${scanned}`);
    console.log(`  with frontmatter:  ${withTimestamps}`);
    console.log(`  rows updated:      ${updated}`);
    console.log(`  download errors:   ${downloadErrors}`);
    console.log(`  parse errors:      ${parseErrors}`);
    console.log(`  elapsed:           ${elapsed}s`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
