import type pg from "pg";

export type DeviceEventBucket =
  | "window"
  | "web"
  | "afk"
  | "focus"
  | "location"
  | (string & {});

export interface UpsertDeviceEventInput {
  source: string;
  sourceEventId: string;
  bucket: DeviceEventBucket;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  app?: string | null;
  title?: string | null;
  url?: string | null;
  hostname?: string | null;
  data?: Record<string, unknown>;
}

export async function upsertDeviceEvent(
  pool: pg.Pool,
  input: UpsertDeviceEventInput
): Promise<void> {
  await pool.query(
    `INSERT INTO device_events
       (source, source_event_id, bucket, started_at, ended_at, duration_ms,
        app, title, url, hostname, data)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (source, source_event_id) DO UPDATE SET
       bucket      = EXCLUDED.bucket,
       started_at  = EXCLUDED.started_at,
       ended_at    = EXCLUDED.ended_at,
       duration_ms = EXCLUDED.duration_ms,
       app         = EXCLUDED.app,
       title       = EXCLUDED.title,
       url         = EXCLUDED.url,
       hostname    = EXCLUDED.hostname,
       data        = EXCLUDED.data,
       ingested_at = NOW()`,
    [
      input.source,
      input.sourceEventId,
      input.bucket,
      input.startedAt,
      input.endedAt ?? null,
      input.durationMs ?? null,
      input.app ?? null,
      input.title ?? null,
      input.url ?? null,
      input.hostname ?? null,
      JSON.stringify(input.data ?? {}),
    ]
  );
}

export async function upsertDeviceEvents(
  pool: pg.Pool,
  rows: UpsertDeviceEventInput[]
): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        `INSERT INTO device_events
           (source, source_event_id, bucket, started_at, ended_at, duration_ms,
            app, title, url, hostname, data)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (source, source_event_id) DO UPDATE SET
           bucket      = EXCLUDED.bucket,
           started_at  = EXCLUDED.started_at,
           ended_at    = EXCLUDED.ended_at,
           duration_ms = EXCLUDED.duration_ms,
           app         = EXCLUDED.app,
           title       = EXCLUDED.title,
           url         = EXCLUDED.url,
           hostname    = EXCLUDED.hostname,
           data        = EXCLUDED.data,
           ingested_at = NOW()`,
        [
          row.source,
          row.sourceEventId,
          row.bucket,
          row.startedAt,
          row.endedAt ?? null,
          row.durationMs ?? null,
          row.app ?? null,
          row.title ?? null,
          row.url ?? null,
          row.hostname ?? null,
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
 * Watermark: most recent started_at we've ingested for a given (source, bucket).
 * Returns null when nothing has been ingested yet.
 */
export async function latestStartedAt(
  pool: pg.Pool,
  source: string,
  bucket?: string
): Promise<Date | null> {
  const sql = bucket
    ? `SELECT MAX(started_at) AS started_at
         FROM device_events
        WHERE source = $1 AND bucket = $2`
    : `SELECT MAX(started_at) AS started_at
         FROM device_events
        WHERE source = $1`;
  const params = bucket ? [source, bucket] : [source];
  const r = await pool.query<{ started_at: Date | null }>(sql, params);
  return r.rows[0]?.started_at ?? null;
}

/**
 * Most recent ingested_at across all device_events. Drives --skip-if-fresh.
 */
export async function latestDeviceEventIngestedAt(
  pool: pg.Pool
): Promise<Date | null> {
  const r = await pool.query<{ ingested_at: Date | null }>(
    `SELECT MAX(ingested_at) AS ingested_at FROM device_events`
  );
  return r.rows[0]?.ingested_at ?? null;
}
