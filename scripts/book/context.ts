import { pool } from "../../src/db/client.js";

export interface ContextItem {
  uuid: string;
  kind: "entry" | "insight";
  date: string;
  title: string | null;
  text: string;
}

const MIN_ENTRY_CHARS = 120;

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
       ORDER BY created_at DESC`,
      [sinceDate, MIN_ENTRY_CHARS]
    ),
    pool.query(
      `SELECT id, title, body, updated_at
       FROM knowledge_artifacts
       WHERE kind = 'insight'
         AND deleted_at IS NULL
         AND (source_path IS NULL OR source_path NOT LIKE '%Pending/%')
         AND updated_at >= $1
       ORDER BY updated_at DESC`,
      [sinceDate]
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

export async function fetchContextByUuid(
  uuids: string[]
): Promise<ContextItem[]> {
  if (uuids.length === 0) return [];

  const [entries, insights] = await Promise.all([
    pool.query(
      `SELECT uuid, created_at, text
       FROM entries
       WHERE uuid = ANY($1::text[])`,
      [uuids]
    ),
    pool.query(
      `SELECT id, title, body, updated_at
       FROM knowledge_artifacts
       WHERE id = ANY($1::uuid[])
         AND deleted_at IS NULL`,
      [uuids]
    ),
  ]);

  const items: ContextItem[] = [];
  for (const r of entries.rows) {
    items.push({
      uuid: r.uuid as string,
      kind: "entry",
      date: (r.created_at as Date).toISOString().slice(0, 10),
      title: null,
      text: r.text as string,
    });
  }
  for (const r of insights.rows) {
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

/**
 * Recent raw journal entries (all languages), most-recent first, for the
 * post-draft verifier's ground-truth window. Unlike gatherContext this applies
 * no exclusion set and no insight join — the verifier wants the unfiltered
 * recent record so it can catch staleness (e.g. a breakup the source insight
 * predates) and unsupported specifics.
 */
export async function fetchRecentEntries(
  daysBack = 21
): Promise<{ date: string; text: string }[]> {
  const sinceDate = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);
  const res = await pool.query(
    `SELECT created_at, text
       FROM entries
      WHERE created_at >= $1
        AND char_length(text) >= $2
      ORDER BY created_at DESC`,
    [sinceDate, MIN_ENTRY_CHARS]
  );
  return res.rows.map((r) => ({
    date: (r.created_at as Date).toISOString().slice(0, 10),
    text: r.text as string,
  }));
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
     ORDER BY updated_at DESC`,
    [sinceDate]
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
  }
  return items;
}
