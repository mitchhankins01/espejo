import type pg from "pg";

export interface UpsertScreenCaptureInput {
  sourceChunkId: string;
  startedAt: Date;
  endedAt: Date;
  app: string | null;
  windowName: string | null;
  ocrText: string | null;
  audioText: string | null;
  embedding: number[] | null;
  data?: Record<string, unknown>;
}

function vectorLiteral(v: number[] | null): string | null {
  if (!v || v.length === 0) return null;
  return `[${v.join(",")}]`;
}

export async function upsertScreenCapture(
  pool: pg.Pool,
  input: UpsertScreenCaptureInput
): Promise<void> {
  const emb = vectorLiteral(input.embedding);
  await pool.query(
    `INSERT INTO screen_captures
       (source_chunk_id, started_at, ended_at, app, window_name,
        ocr_text, audio_text, embedding, data)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)
     ON CONFLICT (source_chunk_id) DO UPDATE SET
       started_at  = EXCLUDED.started_at,
       ended_at    = EXCLUDED.ended_at,
       app         = EXCLUDED.app,
       window_name = EXCLUDED.window_name,
       ocr_text    = EXCLUDED.ocr_text,
       audio_text  = EXCLUDED.audio_text,
       embedding   = COALESCE(EXCLUDED.embedding, screen_captures.embedding),
       data        = EXCLUDED.data,
       ingested_at = NOW()`,
    [
      input.sourceChunkId,
      input.startedAt,
      input.endedAt,
      input.app,
      input.windowName,
      input.ocrText,
      input.audioText,
      emb,
      JSON.stringify(input.data ?? {}),
    ]
  );
}

export async function upsertScreenCaptures(
  pool: pg.Pool,
  rows: UpsertScreenCaptureInput[]
): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const emb = vectorLiteral(row.embedding);
      await client.query(
        `INSERT INTO screen_captures
           (source_chunk_id, started_at, ended_at, app, window_name,
            ocr_text, audio_text, embedding, data)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)
         ON CONFLICT (source_chunk_id) DO UPDATE SET
           started_at  = EXCLUDED.started_at,
           ended_at    = EXCLUDED.ended_at,
           app         = EXCLUDED.app,
           window_name = EXCLUDED.window_name,
           ocr_text    = EXCLUDED.ocr_text,
           audio_text  = EXCLUDED.audio_text,
           embedding   = COALESCE(EXCLUDED.embedding, screen_captures.embedding),
           data        = EXCLUDED.data,
           ingested_at = NOW()`,
        [
          row.sourceChunkId,
          row.startedAt,
          row.endedAt,
          row.app,
          row.windowName,
          row.ocrText,
          row.audioText,
          emb,
          JSON.stringify(row.data ?? {}),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Watermark: most recent started_at we've ingested. Returns null when nothing
 * has been ingested yet.
 */
export async function latestScreenCaptureStartedAt(
  pool: pg.Pool
): Promise<Date | null> {
  const r = await pool.query<{ started_at: Date | null }>(
    `SELECT MAX(started_at) AS started_at FROM screen_captures`
  );
  return r.rows[0]?.started_at ?? null;
}

/**
 * Tiered retention: rows older than `days` keep only their embedding + a short
 * excerpt of OCR. Audio text is dropped entirely (more sensitive, less
 * searchable). Run after each ingest.
 */
export async function pruneOldScreenCaptures(
  pool: pg.Pool,
  days = 14
): Promise<number> {
  const r = await pool.query<{ pruned: number }>(
    `WITH pruned AS (
       UPDATE screen_captures
          SET ocr_text   = LEFT(COALESCE(ocr_text, ''), 200),
              audio_text = NULL
        WHERE started_at < NOW() - ($1 || ' days')::interval
          AND embedding IS NOT NULL
          AND (
            length(coalesce(ocr_text, '')) > 200
            OR audio_text IS NOT NULL
          )
        RETURNING 1
     )
     SELECT COUNT(*)::int AS pruned FROM pruned`,
    [String(days)]
  );
  return r.rows[0]?.pruned ?? 0;
}
