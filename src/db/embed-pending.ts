import type pg from "pg";
import { generateEmbeddingsBatch } from "./embeddings.js";

const BATCH_SIZE = 50;
const MAX_CHARS = 25000;

export interface SkippedItem {
  type: "entry" | "artifact";
  id: string | number;
  title: string;
  chars: number;
}

export interface EmbedResult {
  entries: number;
  artifacts: number;
  skipped: SkippedItem[];
}

/**
 * Embed all entries and artifacts that are missing embeddings.
 * Designed to run on a server timer — processes in batches,
 * skips gracefully if nothing to embed, throws on fatal errors.
 * Items exceeding the token limit are skipped and reported.
 */
export async function embedPending(pool: pg.Pool): Promise<EmbedResult> {
  let entries = 0;
  let artifacts = 0;
  const skipped: SkippedItem[] = [];

  // Entries
  for (;;) {
    const batch = await pool.query(
      `SELECT id, text FROM entries
       WHERE embedding IS NULL AND text IS NOT NULL AND trim(text) != ''
       ORDER BY id LIMIT $1`,
      [BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const embeddable: { id: number; text: string }[] = [];
    for (const row of batch.rows) {
      const text = row.text as string;
      if (text.length > MAX_CHARS) {
        skipped.push({
          type: "entry",
          id: row.id as number,
          title: text.slice(0, 80) + "...",
          chars: text.length,
        });
        continue;
      }
      embeddable.push({ id: row.id as number, text });
    }

    if (embeddable.length > 0) {
      const texts = embeddable.map((r) => r.text);
      const ids = embeddable.map((r) => r.id);
      const embeddings = await generateEmbeddingsBatch(texts);

      const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
      await pool.query(
        `UPDATE entries SET embedding = data.emb::vector
         FROM unnest($1::int[], $2::text[]) AS data(id, emb)
         WHERE entries.id = data.id`,
        [ids, embeddingStrs]
      );
      entries += embeddable.length;
    }

    // If entire batch was skipped, we'd loop forever — mark skipped entries
    // with a sentinel so they drop out of the WHERE filter
    if (embeddable.length === 0) break;
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

    const embeddable: { id: string; text: string }[] = [];
    for (const row of batch.rows) {
      const text = `${row.title as string}\n\n${row.body as string}`;
      if (text.length > MAX_CHARS) {
        skipped.push({
          type: "artifact",
          id: row.id as string,
          title: row.title as string,
          chars: text.length,
        });
        continue;
      }
      embeddable.push({ id: row.id as string, text });
    }

    if (embeddable.length > 0) {
      const texts = embeddable.map((r) => r.text);
      const ids = embeddable.map((r) => r.id);
      const embeddings = await generateEmbeddingsBatch(texts);

      const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
      await pool.query(
        `UPDATE knowledge_artifacts SET embedding = data.emb::vector
         FROM unnest($1::uuid[], $2::text[]) AS data(id, emb)
         WHERE knowledge_artifacts.id = data.id`,
        [ids, embeddingStrs]
      );
      artifacts += embeddable.length;
    }

    if (embeddable.length === 0) break;
  }

  return { entries, artifacts, skipped };
}
