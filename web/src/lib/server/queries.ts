import type pg from "pg";
import type { JournalEntry, TagCount } from "@espejo/shared";
import crypto from "node:crypto";

// ============================================================================
// List entries (paginated, newest first)
// ============================================================================

export async function listEntries(
  pool: pg.Pool,
  limit: number,
  offset: number
): Promise<{ entries: JournalEntry[]; total: number }> {
  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM entries"
  );
  const total = countResult.rows[0].total as number;

  const result = await pool.query(
    `SELECT
      e.*,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count
    FROM entries e
    ORDER BY e.created_at DESC
    LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return { entries: result.rows.map(mapEntryRow), total };
}

// ============================================================================
// Get single entry by UUID
// ============================================================================

export async function getEntry(
  pool: pg.Pool,
  uuid: string
): Promise<JournalEntry | null> {
  const result = await pool.query(
    `SELECT
      e.*,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count
    FROM entries e
    WHERE e.uuid = $1`,
    [uuid]
  );

  if (result.rows.length === 0) return null;
  return mapEntryRow(result.rows[0]);
}

// ============================================================================
// Create entry
// ============================================================================

export async function createEntry(
  pool: pg.Pool,
  input: {
    text: string;
    tags?: string[];
    timezone?: string;
  }
): Promise<JournalEntry> {
  const uuid = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO entries (uuid, text, created_at, timezone)
       VALUES ($1, $2, NOW(), $3)
       RETURNING *`,
      [
        uuid,
        input.text,
        input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ]
    );

    const entryId = result.rows[0].id as number;

    if (input.tags && input.tags.length > 0) {
      await syncTags(client, entryId, input.tags);
    }

    await client.query("COMMIT");
    return (await getEntry(pool, uuid))!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// Update entry
// ============================================================================

export async function updateEntry(
  pool: pg.Pool,
  uuid: string,
  input: {
    text?: string;
    tags?: string[];
  }
): Promise<JournalEntry | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Build dynamic SET clause
    const setClauses: string[] = ["modified_at = NOW()"];
    const params: unknown[] = [];
    let idx = 0;

    if (input.text !== undefined) {
      idx++;
      setClauses.push(`text = $${idx}`);
      params.push(input.text);
    }

    idx++;
    params.push(uuid);

    const result = await client.query(
      `UPDATE entries SET ${setClauses.join(", ")} WHERE uuid = $${idx} RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const entryId = result.rows[0].id as number;

    if (input.tags !== undefined) {
      await syncTags(client, entryId, input.tags);
    }

    await client.query("COMMIT");
    return await getEntry(pool, uuid);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// Delete entry
// ============================================================================

export async function deleteEntry(
  pool: pg.Pool,
  uuid: string
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM entries WHERE uuid = $1 RETURNING id",
    [uuid]
  );
  return result.rows.length > 0;
}

// ============================================================================
// List all tags (for autocomplete)
// ============================================================================

export async function listAllTags(pool: pg.Pool): Promise<TagCount[]> {
  const result = await pool.query(
    `SELECT t.name, COUNT(et.entry_id)::int AS count
     FROM tags t
     JOIN entry_tags et ON et.tag_id = t.id
     GROUP BY t.id, t.name
     ORDER BY count DESC, t.name ASC`
  );
  return result.rows;
}

// ============================================================================
// Helpers
// ============================================================================

async function syncTags(
  client: pg.PoolClient,
  entryId: number,
  tags: string[]
): Promise<void> {
  // Remove existing tags
  await client.query("DELETE FROM entry_tags WHERE entry_id = $1", [entryId]);

  if (tags.length === 0) return;

  // Upsert tags
  await client.query(
    `INSERT INTO tags (name)
     SELECT unnest($1::text[])
     ON CONFLICT (name) DO NOTHING`,
    [tags]
  );

  // Link tags to entry
  await client.query(
    `INSERT INTO entry_tags (entry_id, tag_id)
     SELECT $1, t.id FROM tags t WHERE t.name = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [entryId, tags]
  );
}

function mapEntryRow(row: Record<string, unknown>): JournalEntry {
  const text = row.text as string | null;
  return {
    uuid: row.uuid as string,
    text,
    created_at: (row.created_at as Date).toISOString(),
    modified_at: row.modified_at
      ? (row.modified_at as Date).toISOString()
      : null,
    timezone: row.timezone as string | null,
    tags: (row.tags as string[]) || [],
    city: row.city as string | null,
    country: row.country as string | null,
    place_name: row.place_name as string | null,
    admin_area: row.admin_area as string | null,
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    weather:
      row.temperature !== null || row.weather_conditions !== null
        ? {
            temperature: row.temperature as number | null,
            conditions: row.weather_conditions as string | null,
            humidity: row.humidity as number | null,
          }
        : null,
    word_count: text ? text.split(/\s+/).filter((w) => w.length > 0).length : 0,
    media_counts: {
      photos: (row.photo_count as number) ?? 0,
      videos: (row.video_count as number) ?? 0,
      audios: (row.audio_count as number) ?? 0,
    },
  };
}
