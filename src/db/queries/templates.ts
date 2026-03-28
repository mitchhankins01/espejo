import type pg from "pg";

// ============================================================================
// Web journaling: Entry templates
// ============================================================================

export interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  system_prompt: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

const TEMPLATE_COLUMNS = `id, slug, name, description, body, system_prompt, sort_order, created_at, updated_at`;

function toTemplateRow(row: Record<string, unknown>): TemplateRow {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    body: row.body as string,
    system_prompt: (row.system_prompt as string | null) ?? null,
    /* v8 ignore next */
    sort_order: (row.sort_order as number) ?? 0,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export async function listTemplates(
  pool: pg.Pool
): Promise<TemplateRow[]> {
  const result = await pool.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM entry_templates ORDER BY sort_order ASC, created_at ASC`
  );
  return result.rows.map((row) => toTemplateRow(row as Record<string, unknown>));
}

export async function getTemplateById(
  pool: pg.Pool,
  id: string
): Promise<TemplateRow | null> {
  const result = await pool.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM entry_templates WHERE id = $1`,
    [id]
  );
  /* v8 ignore next */
  if (result.rows.length === 0) return null;
  return toTemplateRow(result.rows[0] as Record<string, unknown>);
}

export async function getTemplateBySlug(
  pool: pg.Pool,
  slug: string
): Promise<TemplateRow | null> {
  const result = await pool.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM entry_templates WHERE slug = $1`,
    [slug]
  );
  if (result.rows.length === 0) return null;
  return toTemplateRow(result.rows[0] as Record<string, unknown>);
}

export async function createTemplate(
  pool: pg.Pool,
  data: {
    slug: string;
    name: string;
    description?: string;
    body?: string;
    system_prompt?: string | null;
    sort_order?: number;
  }
): Promise<TemplateRow> {
  const result = await pool.query(
    `INSERT INTO entry_templates (slug, name, description, body, system_prompt, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      data.slug,
      data.name,
      data.description ?? null,
      data.body ?? "",
      data.system_prompt ?? null,
      data.sort_order ?? 0,
    ]
  );
  return toTemplateRow(result.rows[0] as Record<string, unknown>);
}

export async function updateTemplate(
  pool: pg.Pool,
  id: string,
  data: {
    slug?: string;
    name?: string;
    description?: string;
    body?: string;
    system_prompt?: string | null;
    sort_order?: number;
  }
): Promise<TemplateRow | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (data.slug !== undefined) {
    paramIdx++;
    setClauses.push(`slug = $${paramIdx}`);
    params.push(data.slug);
  }
  if (data.name !== undefined) {
    paramIdx++;
    setClauses.push(`name = $${paramIdx}`);
    params.push(data.name);
  }
  if (data.description !== undefined) {
    paramIdx++;
    setClauses.push(`description = $${paramIdx}`);
    params.push(data.description);
  }
  if (data.body !== undefined) {
    paramIdx++;
    setClauses.push(`body = $${paramIdx}`);
    params.push(data.body);
  }
  if (data.system_prompt !== undefined) {
    paramIdx++;
    setClauses.push(`system_prompt = $${paramIdx}`);
    params.push(data.system_prompt);
  }
  if (data.sort_order !== undefined) {
    paramIdx++;
    setClauses.push(`sort_order = $${paramIdx}`);
    params.push(data.sort_order);
  }

  if (setClauses.length === 0) {
    return getTemplateById(pool, id);
  }

  paramIdx++;
  params.push(id);

  const result = await pool.query(
    `UPDATE entry_templates
     SET ${setClauses.join(", ")}
     WHERE id = $${paramIdx}
     RETURNING ${TEMPLATE_COLUMNS}`,
    params
  );

  if (result.rows.length === 0) return null;
  return toTemplateRow(result.rows[0] as Record<string, unknown>);
}

export async function deleteTemplate(
  pool: pg.Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM entry_templates WHERE id = $1`,
    [id]
  );
  /* v8 ignore next */
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get entry internal ID by UUID. Used by media upload to resolve entry_id FK.
 */
export async function getEntryIdByUuid(
  pool: pg.Pool,
  uuid: string
): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM entries WHERE uuid = $1`,
    [uuid]
  );
  return result.rows.length > 0 ? (result.rows[0].id as number) : null;
}
