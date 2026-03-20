import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
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

function elapsed(start: bigint): string {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function embedEntries(force: boolean): Promise<void> {
  const t0 = process.hrtime.bigint();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENAI_API_KEY is required. Set it in your .env file or environment."
    );
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // Verify DB connection
  const connTest = process.hrtime.bigint();
  await pool.query("SELECT 1");
  console.log(`PostgreSQL connected [ping: ${elapsed(connTest)}]`);

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
  } else {

  const totalBatches = Math.ceil(totalCount / BATCH_SIZE);
  console.log(`Embedding ${totalCount} entries (${totalBatches} batches of ${BATCH_SIZE})...`);

  let processed = 0;
  let batchNum = 0;

  while (processed < totalCount) {
    batchNum++;
    const batchStart = process.hrtime.bigint();

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
      const apiStart = process.hrtime.bigint();
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });
      const apiTime = elapsed(apiStart);

      const sorted = response.data.sort((a, b) => a.index - b.index);

      // Batch update all entries in one query using unnest()
      const dbStart = process.hrtime.bigint();
      const embeddingStrs = sorted.map(
        (d) => `[${d.embedding.join(",")}]`
      );
      await pool.query(
        `UPDATE entries SET embedding = data.emb::vector
         FROM unnest($1::int[], $2::text[]) AS data(id, emb)
         WHERE entries.id = data.id`,
        [ids, embeddingStrs]
      );
      const dbTime = elapsed(dbStart);

      processed += batch.rows.length;
      const remaining = totalCount - processed;
      const batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
      const etaMin = (remaining / BATCH_SIZE) * (batchMs + SLEEP_MS) / 60000;
      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${processed}/${totalCount} [API: ${apiTime}, DB: ${dbTime}, ETA: ${etaMin.toFixed(1)}min]`
      );
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

    console.log(`Done. Embedded ${processed} entries. [${elapsed(t0)}]`);
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Embed knowledge artifacts
  // ---------------------------------------------------------------------------
  const artifactWhere = force
    ? "WHERE body IS NOT NULL AND deleted_at IS NULL"
    : "WHERE embedding IS NULL AND body IS NOT NULL AND deleted_at IS NULL";
  const artifactCountResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM knowledge_artifacts ${artifactWhere}`
  );
  const artifactCount = artifactCountResult.rows[0].count as number;

  if (artifactCount === 0) {
    console.log("All artifacts already have embeddings.");
  } else {
    const artifactBatches = Math.ceil(artifactCount / BATCH_SIZE);
    console.log(`\nEmbedding ${artifactCount} artifacts (${artifactBatches} batches)...`);

    let artProcessed = 0;
    let artBatchNum = 0;

    while (artProcessed < artifactCount) {
      artBatchNum++;
      const batchStart = process.hrtime.bigint();

      const batch = await pool.query(
        `SELECT id, title, body FROM knowledge_artifacts ${artifactWhere}
         ORDER BY created_at
         LIMIT $1`,
        [BATCH_SIZE]
      );

      if (batch.rows.length === 0) break;

      const texts = batch.rows.map(
        (row) => `${row.title as string}\n\n${row.body as string}`
      );
      const ids = batch.rows.map((row) => row.id as string);

      try {
        const apiStart = process.hrtime.bigint();
        const response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
        });
        const apiTime = elapsed(apiStart);

        const sorted = response.data.sort((a, b) => a.index - b.index);

        const dbStart = process.hrtime.bigint();
        const embeddingStrs = sorted.map(
          (d) => `[${d.embedding.join(",")}]`
        );
        await pool.query(
          `UPDATE knowledge_artifacts SET embedding = data.emb::vector
           FROM unnest($1::uuid[], $2::text[]) AS data(id, emb)
           WHERE knowledge_artifacts.id = data.id`,
          [ids, embeddingStrs]
        );
        const dbTime = elapsed(dbStart);

        artProcessed += batch.rows.length;
        const remaining = artifactCount - artProcessed;
        const batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
        const etaMin = (remaining / BATCH_SIZE) * (batchMs + SLEEP_MS) / 60000;
        console.log(
          `  Batch ${artBatchNum}/${artifactBatches}: ${artProcessed}/${artifactCount} [API: ${apiTime}, DB: ${dbTime}, ETA: ${etaMin.toFixed(1)}min]`
        );
      } catch (err) {
        console.error(
          `  Error embedding artifact batch at ${artProcessed}: ${err instanceof Error ? err.message : err}`
        );
        break;
      }

      if (artProcessed < artifactCount) {
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
      }
    }

    console.log(`Done. Embedded ${artProcessed} artifacts.`);
  }

  console.log(`Total time: ${elapsed(t0)}`);
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
