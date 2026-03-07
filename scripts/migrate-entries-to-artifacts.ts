/**
 * One-off migration: move specific journal entries to knowledge artifacts.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-entries-to-artifacts.ts
 *   NODE_ENV=production DATABASE_URL=<url> pnpm tsx scripts/migrate-entries-to-artifacts.ts
 */
import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env", override: true });
}

import pg from "pg";

const ENTRY_UUIDS = [
  "ABE997F429E748D096E2A259B6C382D4", // The Classroom and the Hypothesis
  "B7661965A4E342949FEB001EE3CFF67E", // Debugging the Pull-Away
  "0AFFC8015C694A3F86816BEEAC078B55", // The Car Theory / Hypothesis
  "276856A75B7A4735B790D08F0ED869FE", // The Attachment Wound Hypothesis
  "DE1E3D7D9DE94D8D86D3DBA69E36E51E", // From Cage to Freedom
];

const KIND = "insight";

function extractTitleAndBody(text: string): { title: string; body: string } {
  const lines = text.split("\n");
  // Find first markdown heading
  const headingIdx = lines.findIndex((l) => /^#+\s/.test(l));
  if (headingIdx !== -1) {
    const title = lines[headingIdx].replace(/^#+\s*/, "").trim();
    // Body is everything after the heading, trimmed
    const body = lines
      .slice(headingIdx + 1)
      .join("\n")
      .trim();
    return { title, body };
  }
  // Fallback: first line as title, rest as body
  return {
    title: lines[0].trim(),
    body: lines.slice(1).join("\n").trim(),
  };
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Check which entries exist
    const { rows: entries } = await pool.query<{ uuid: string; text: string }>(
      `SELECT uuid, text FROM entries WHERE uuid = ANY($1)`,
      [ENTRY_UUIDS]
    );

    if (entries.length === 0) {
      console.log("No matching entries found in this database. Nothing to migrate.");
      return;
    }

    console.log(`Found ${entries.length} entries to migrate.`);

    for (const entry of entries) {
      const { title, body } = extractTitleAndBody(entry.text);

      // Check if artifact already exists (idempotent)
      const { rows: existing } = await pool.query(
        `SELECT id FROM knowledge_artifacts WHERE title = $1`,
        [title]
      );
      if (existing.length > 0) {
        console.log(`  SKIP: "${title}" — artifact already exists`);
        continue;
      }

      // Create artifact with source link in a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: [artifact] } = await client.query<{ id: string }>(
          `INSERT INTO knowledge_artifacts (kind, title, body, tags)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [KIND, title, body, ["llm"]]
        );

        await client.query(
          `INSERT INTO knowledge_artifact_sources (artifact_id, entry_uuid)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [artifact.id, entry.uuid]
        );

        await client.query("COMMIT");
        console.log(`  OK: "${title}" → artifact ${artifact.id}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAIL: "${title}" — ${err}`);
      } finally {
        client.release();
      }
    }

    console.log("\nDone. Run `pnpm embed` to generate embeddings for the new artifacts.");
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
