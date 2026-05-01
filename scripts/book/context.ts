import { pool } from "../../src/db/client.js";

export interface ContextItem {
  uuid: string;
  kind: "entry" | "insight";
  date: string;
  title: string | null;
  text: string;
}

const ENTRY_LIMIT = 50;
const INSIGHT_LIMIT = 40;
const MIN_ENTRY_CHARS = 120;

const LONG_ARC_LIMIT = 25;
const LONG_ARC_DAYS = 365;

export async function gatherContext(
  excludeUuids: Set<string>,
  daysBack = 14
): Promise<ContextItem[]> {
  const sinceDate = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

  const [entries, insights] = await Promise.all([
    pool.query(
      `SELECT uuid, created_at, text
       FROM entries
       WHERE created_at >= $1
         AND char_length(text) >= $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [sinceDate, MIN_ENTRY_CHARS, ENTRY_LIMIT]
    ),
    pool.query(
      `SELECT id, title, body, updated_at
       FROM knowledge_artifacts
       WHERE kind = 'insight'
         AND deleted_at IS NULL
         AND (source_path IS NULL OR source_path NOT LIKE '%Pending/%')
         AND updated_at >= $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [sinceDate, INSIGHT_LIMIT]
    ),
  ]);

  const items: ContextItem[] = [];

  for (const r of entries.rows) {
    if (excludeUuids.has(r.uuid as string)) continue;
    items.push({
      uuid: r.uuid as string,
      kind: "entry",
      date: (r.created_at as Date).toISOString().slice(0, 10),
      title: null,
      text: r.text as string,
    });
  }

  for (const r of insights.rows) {
    if (excludeUuids.has(r.id as string)) continue;
    items.push({
      uuid: r.id as string,
      kind: "insight",
      date: (r.updated_at as Date).toISOString().slice(0, 10),
      title: r.title as string,
      text: r.body as string,
    });
  }

  return items;
}

export async function gatherLongArcContext(
  excludeUuids: Set<string>,
  excludeRecentUuids: Set<string>,
  daysBack = LONG_ARC_DAYS
): Promise<ContextItem[]> {
  const sinceDate = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

  const insights = await pool.query(
    `SELECT id, title, body, updated_at
     FROM knowledge_artifacts
     WHERE kind = 'insight'
       AND deleted_at IS NULL
       AND (source_path IS NULL OR source_path NOT LIKE '%Pending/%')
       AND updated_at >= $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [sinceDate, LONG_ARC_LIMIT * 4]
  );

  const items: ContextItem[] = [];
  for (const r of insights.rows) {
    const id = r.id as string;
    if (excludeUuids.has(id)) continue;
    if (excludeRecentUuids.has(id)) continue;
    items.push({
      uuid: id,
      kind: "insight",
      date: (r.updated_at as Date).toISOString().slice(0, 10),
      title: r.title as string,
      text: r.body as string,
    });
    if (items.length >= LONG_ARC_LIMIT) break;
  }
  return items;
}
