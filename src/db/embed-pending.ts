import type pg from "pg";
import { generateEmbeddingsBatch } from "./embeddings.js";

const BATCH_SIZE = 50;
const MAX_CHARS = 25000;

function truncate(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

export interface EmbedResult {
  entries: number;
  artifacts: number;
}

/**
 * Embed all entries and artifacts that are missing embeddings.
 * Designed to run on a server timer — processes in batches,
 * skips gracefully if nothing to embed, throws on fatal errors.
 */
export async function embedPending(pool: pg.Pool): Promise<EmbedResult> {
  let entries = 0;
  let artifacts = 0;

  // Entries
  for (;;) {
    const batch = await pool.query(
      `SELECT id, text FROM entries
       WHERE embedding IS NULL AND text IS NOT NULL AND trim(text) != ''
       ORDER BY id LIMIT $1`,
      [BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const texts = batch.rows.map((r) => truncate(r.text as string));
    const ids = batch.rows.map((r) => r.id as number);
    const embeddings = await generateEmbeddingsBatch(texts);

    const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
    await pool.query(
      `UPDATE entries SET embedding = data.emb::vector
       FROM unnest($1::int[], $2::text[]) AS data(id, emb)
       WHERE entries.id = data.id`,
      [ids, embeddingStrs]
    );
    entries += batch.rows.length;
  }

  // Artifacts
  for (;;) {
    const batch = await pool.query(
      `SELECT id, title, body FROM knowledge_artifacts
       WHERE embedding IS NULL AND body IS NOT NULL AND deleted_at IS NULL
       ORDER BY created_at LIMIT $1`,
      [BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const texts = batch.rows.map((r) =>
      truncate(`${r.title as string}\n\n${r.body as string}`)
    );
    const ids = batch.rows.map((r) => r.id as string);
    const embeddings = await generateEmbeddingsBatch(texts);

    const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = data.emb::vector
       FROM unnest($1::uuid[], $2::text[]) AS data(id, emb)
       WHERE knowledge_artifacts.id = data.id`,
      [ids, embeddingStrs]
    );
    artifacts += batch.rows.length;
  }

  return { entries, artifacts };
}
