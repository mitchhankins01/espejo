import type pg from "pg";
import { generateEmbeddingsBatch } from "./embeddings.js";

const BATCH_SIZE = 50;
const MAX_CHARS = 25000;
// Target chunk size when splitting oversized items. Leaves headroom under
// MAX_CHARS so a single chunk never bumps against the embedding token limit.
const CHUNK_TARGET = 20000;
// Hard cap on chunks per item — guards against pathological inputs (a 1MB note
// shouldn't quietly fan out into 50 embedding calls).
const MAX_CHUNKS = 10;

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

interface Embeddable<Id> {
  id: Id;
  chunks: string[];
}

/**
 * Split text into chunks of roughly CHUNK_TARGET chars, preferring paragraph
 * boundaries, then sentence boundaries, with a hard slice as last resort.
 */
export function chunkText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  const flush = (): void => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  const append = (piece: string): void => {
    if (!current) {
      current = piece;
    } else if (current.length + piece.length + 2 <= CHUNK_TARGET) {
      current = `${current}\n\n${piece}`;
    } else {
      flush();
      current = piece;
    }
  };

  const splitLong = (piece: string): string[] => {
    if (piece.length <= CHUNK_TARGET) return [piece];
    // Sentence-ish split first
    const sentences = piece.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1 && sentences.every((s) => s.length <= CHUNK_TARGET)) {
      return sentences;
    }
    // Hard slice
    const out: string[] = [];
    for (let i = 0; i < piece.length; i += CHUNK_TARGET) {
      out.push(piece.slice(i, i + CHUNK_TARGET));
    }
    return out;
  };

  for (const para of paragraphs) {
    if (para.length > CHUNK_TARGET) {
      flush();
      for (const piece of splitLong(para)) append(piece);
      continue;
    }
    append(para);
  }
  flush();

  return chunks;
}

/**
 * Element-wise mean of N vectors. All vectors must have identical length.
 */
export function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 1) return vectors[0];
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vectors.length);
}

/**
 * Embed a list of items by flattening chunks into a single batch call,
 * then averaging the per-chunk vectors back into one vector per item.
 */
async function embedItems<Id>(items: Embeddable<Id>[]): Promise<number[][]> {
  if (items.length === 0) return [];
  const flatTexts: string[] = [];
  for (const item of items) flatTexts.push(...item.chunks);

  const flatEmbeddings = await generateEmbeddingsBatch(flatTexts);

  const out: number[][] = [];
  let offset = 0;
  for (const item of items) {
    const slice = flatEmbeddings.slice(offset, offset + item.chunks.length);
    out.push(averageVectors(slice));
    offset += item.chunks.length;
  }
  return out;
}

/**
 * Embed all entries and artifacts that are missing embeddings.
 * Designed to run on a server timer — processes in batches,
 * skips gracefully if nothing to embed, throws on fatal errors.
 * Oversized items are chunked and averaged to a single vector.
 * Items beyond MAX_CHUNKS are skipped and reported.
 */
export async function embedPending(pool: pg.Pool): Promise<EmbedResult> {
  let entries = 0;
  let artifacts = 0;
  const skipped: SkippedItem[] = [];
  const skippedEntryIds = new Set<number>();
  const skippedArtifactIds = new Set<string>();

  // Entries
  for (;;) {
    const batch = await pool.query(
      `SELECT id, text FROM entries
       WHERE embedding IS NULL AND text IS NOT NULL AND trim(text) != ''
         AND ($1::int[] IS NULL OR id <> ALL($1::int[]))
       ORDER BY id LIMIT $2`,
      [skippedEntryIds.size > 0 ? Array.from(skippedEntryIds) : null, BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const embeddable: Embeddable<number>[] = [];
    for (const row of batch.rows) {
      const text = row.text as string;
      const id = row.id as number;
      const chunks = chunkText(text);
      if (chunks.length > MAX_CHUNKS) {
        skippedEntryIds.add(id);
        skipped.push({
          type: "entry",
          id,
          title: text.slice(0, 80) + "...",
          chars: text.length,
        });
        continue;
      }
      embeddable.push({ id, chunks });
    }

    if (embeddable.length > 0) {
      const embeddings = await embedItems(embeddable);
      const ids = embeddable.map((r) => r.id);
      const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
      await pool.query(
        `UPDATE entries SET embedding = data.emb::vector
         FROM unnest($1::int[], $2::text[]) AS data(id, emb)
         WHERE entries.id = data.id`,
        [ids, embeddingStrs]
      );
      entries += embeddable.length;
    } else {
      // Whole batch was skipped — exclusion list keeps us from re-fetching them
      // forever, but we still need to break if we've drained the table.
      break;
    }
  }

  // Artifacts
  for (;;) {
    const batch = await pool.query(
      `SELECT id, title, body FROM knowledge_artifacts
       WHERE embedding IS NULL AND body IS NOT NULL AND deleted_at IS NULL
         AND ($1::uuid[] IS NULL OR id <> ALL($1::uuid[]))
       ORDER BY created_at LIMIT $2`,
      [skippedArtifactIds.size > 0 ? Array.from(skippedArtifactIds) : null, BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const embeddable: Embeddable<string>[] = [];
    for (const row of batch.rows) {
      const id = row.id as string;
      const title = row.title as string;
      const body = row.body as string;
      const text = `${title}\n\n${body}`;
      const chunks = chunkText(text);
      if (chunks.length > MAX_CHUNKS) {
        skippedArtifactIds.add(id);
        skipped.push({
          type: "artifact",
          id,
          title,
          chars: text.length,
        });
        continue;
      }
      embeddable.push({ id, chunks });
    }

    if (embeddable.length > 0) {
      const embeddings = await embedItems(embeddable);
      const ids = embeddable.map((r) => r.id);
      const embeddingStrs = embeddings.map((e) => `[${e.join(",")}]`);
      await pool.query(
        `UPDATE knowledge_artifacts SET embedding = data.emb::vector
         FROM unnest($1::uuid[], $2::text[]) AS data(id, emb)
         WHERE knowledge_artifacts.id = data.id`,
        [ids, embeddingStrs]
      );
      artifacts += embeddable.length;
    } else {
      break;
    }
  }

  return { entries, artifacts, skipped };
}
