import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
}
import pg from "pg";
import OpenAI from "openai";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://dev:dev@localhost:5434/journal_dev";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100;
const SLEEP_MS = 1000;

async function embedEntries(force: boolean): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENAI_API_KEY is required. Set it in your .env file or environment."
    );
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // Get entries that need embedding
  const whereClause = force
    ? "WHERE text IS NOT NULL AND trim(text) != ''"
    : "WHERE embedding IS NULL AND text IS NOT NULL AND trim(text) != ''";
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM entries ${whereClause}`
  );
  const totalCount = countResult.rows[0].count as number;

  if (totalCount === 0) {
    console.log("All entries already have embeddings. Use --force to re-embed.");
    await pool.end();
    return;
  }

  console.log(`Embedding ${totalCount} entries (batch size: ${BATCH_SIZE})...`);

  let processed = 0;

  while (processed < totalCount) {
    // Fetch batch (no OFFSET — completed rows drop out of the WHERE filter)
    const batch = await pool.query(
      `SELECT id, text FROM entries ${whereClause}
       ORDER BY id
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batch.rows.length === 0) break;

    const texts = batch.rows.map(
      (row) => (row.text as string) || ""
    );
    const ids = batch.rows.map((row) => row.id as number);

    try {
      // Generate embeddings
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      const sorted = response.data.sort((a, b) => a.index - b.index);

      // Update entries with embeddings
      for (let i = 0; i < ids.length; i++) {
        const embeddingStr = `[${sorted[i].embedding.join(",")}]`;
        await pool.query(
          "UPDATE entries SET embedding = $1::vector WHERE id = $2",
          [embeddingStr, ids[i]]
        );
      }

      processed += batch.rows.length;
      console.log(`  ${processed}/${totalCount} embedded`);
    } catch (err) {
      console.error(
        `  Error embedding batch at ${processed}: ${err instanceof Error ? err.message : err}`
      );
      // Skip this batch — entries stay unembedded for retry
      break;
    }

    // Rate limiting
    if (processed < totalCount) {
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }

  console.log(`Done. Embedded ${processed} entries.`);
  await pool.end();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const force = process.argv.includes("--force");
embedEntries(force).catch((err) => {
  console.error("Embedding failed:", err);
  process.exit(1);
});
