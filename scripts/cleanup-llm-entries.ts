/**
 * Cleanup: Delete entries tagged `llm` from the production database.
 * These entries have been migrated to knowledge artifacts and are no longer needed.
 *
 * Usage:
 *   pnpm tsx scripts/cleanup-llm-entries.ts
 *   echo "y" | pnpm tsx scripts/cleanup-llm-entries.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.production.local", override: true });

import pg from "pg";
import readline from "readline";

const databaseUrl = process.env.DATABASE_URL || "postgresql://dev:dev@localhost:5434/journal_dev";

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Step 1: Find entries tagged 'llm'
    const entriesResult = await pool.query(
      `SELECT e.id, e.uuid, e.created_at
       FROM entries e
       JOIN entry_tags et ON et.entry_id = e.id
       JOIN tags t ON t.id = et.tag_id
       WHERE t.name = 'llm'
       ORDER BY e.created_at ASC`
    );

    const entries = entriesResult.rows as Array<{ id: number; uuid: string; created_at: Date }>;

    if (entries.length === 0) {
      console.log("No entries tagged 'llm' found. Nothing to delete.");
      return;
    }

    // Step 2: Show what will be deleted
    const minDate = entries[0].created_at.toISOString().split("T")[0];
    const maxDate = entries[entries.length - 1].created_at.toISOString().split("T")[0];

    console.log(`\nFound ${entries.length} entries tagged 'llm'`);
    console.log(`Date range: ${minDate} to ${maxDate}\n`);
    console.log("UUIDs:");
    for (const entry of entries) {
      const date = entry.created_at.toISOString().split("T")[0];
      console.log(`  ${entry.uuid}  (${date})`);
    }

    // Check for artifact source references
    const uuids = entries.map((e) => e.uuid);
    const sourceRefs = await pool.query(
      `SELECT entry_uuid, COUNT(*) AS ref_count
       FROM knowledge_artifact_sources
       WHERE entry_uuid = ANY($1)
       GROUP BY entry_uuid`,
      [uuids]
    );
    if (sourceRefs.rows.length > 0) {
      console.log(`\n${sourceRefs.rows.length} entries have artifact source references (will be removed first).`);
    }

    // Step 3: Ask for confirmation
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\nDelete ${entries.length} entries? (y/N) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }

    // Step 4: Delete in correct order
    const entryIds = entries.map((e) => e.id);

    // Delete artifact source references first (ON DELETE RESTRICT)
    const sourceDeleteResult = await pool.query(
      `DELETE FROM knowledge_artifact_sources WHERE entry_uuid = ANY($1)`,
      [uuids]
    );
    console.log(`Deleted ${sourceDeleteResult.rowCount} artifact source references.`);

    // Delete entries (entry_tags and media cascade automatically)
    const entryDeleteResult = await pool.query(
      `DELETE FROM entries WHERE id = ANY($1)`,
      [entryIds]
    );
    console.log(`Deleted ${entryDeleteResult.rowCount} entries (entry_tags + media cascaded).`);

    // Step 5: Summary
    console.log(`\n--- Summary ---`);
    console.log(`Entries deleted: ${entryDeleteResult.rowCount}`);
    console.log(`Artifact source refs removed: ${sourceDeleteResult.rowCount}`);
    console.log(`\nUUIDs (for Day One deletion):`);
    for (const uuid of uuids) {
      console.log(`  ${uuid}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
