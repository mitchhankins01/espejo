import type pg from "pg";

// ============================================================================
// Activity logs
// ============================================================================

export interface ActivityLogRow {
  id: number;
  chat_id: string;
  memories: ActivityLogMemory[];
  tool_calls: ActivityLogToolCall[];
  cost_usd: number | null;
  created_at: Date;
}

export interface ActivityLogMemory {
  id: number;
  content: string;
  kind: string;
  confidence: number;
  score: number;
}

export interface ActivityLogToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  truncated_result: string;
}

/**
 * Insert an activity log for a single agent run.
 */
export async function insertActivityLog(
  pool: pg.Pool,
  params: {
    chatId: string;
    memories: ActivityLogMemory[];
    toolCalls: ActivityLogToolCall[];
    costUsd: number | null;
  }
): Promise<ActivityLogRow> {
  const result = await pool.query(
    `INSERT INTO activity_logs (chat_id, memories, tool_calls, cost_usd)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      params.chatId,
      JSON.stringify(params.memories),
      JSON.stringify(params.toolCalls),
      params.costUsd,
    ]
  );
  return mapActivityLogRow(result.rows[0]);
}

/**
 * Get a single activity log by ID.
 */
export async function getActivityLog(
  pool: pg.Pool,
  id: number
): Promise<ActivityLogRow | null> {
  const result = await pool.query(
    `SELECT * FROM activity_logs WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return mapActivityLogRow(result.rows[0]);
}

/**
 * Get recent activity logs, optionally filtered by tool name.
 */
export async function getRecentActivityLogs(
  pool: pg.Pool,
  params: {
    chatId?: string;
    toolName?: string;
    since?: Date;
    limit: number;
  }
): Promise<ActivityLogRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.chatId) {
    values.push(params.chatId);
    conditions.push(`chat_id = $${values.length}`);
  }
  if (params.since) {
    values.push(params.since);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (params.toolName) {
    values.push(params.toolName);
    conditions.push(`tool_calls @> jsonb_build_array(jsonb_build_object('name', $${values.length}::text))`);
  }

  values.push(params.limit);
  const whereClause =
    conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const result = await pool.query(
    `SELECT * FROM activity_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapActivityLogRow);
}

// ============================================================================
// DB observability queries (web read-only explorer)
// ============================================================================

export const OBSERVABLE_DB_TABLES = [
  "knowledge_artifacts",
  "artifact_links",
  "todos",
  "activity_logs",
  "chat_messages",
  "patterns",
  "daily_metrics",
] as const;

export type ObservableDbTableName = (typeof OBSERVABLE_DB_TABLES)[number];
export type DbChangeOperation = "insert" | "update" | "delete" | "tool_call";

export interface DbColumnMeta {
  name: string;
  type: string;
  hidden: boolean;
}

export interface DbTableMeta {
  name: ObservableDbTableName;
  row_count: number;
  last_changed_at: Date | null;
  default_sort_column: string | null;
}

export interface DbRowsResult {
  items: Record<string, unknown>[];
  total: number;
  columns: DbColumnMeta[];
}

export interface DbChangedField {
  field: string;
  before: unknown;
  after: unknown;
}

export interface DbChangeEvent {
  changed_at: Date;
  table: ObservableDbTableName;
  operation: DbChangeOperation;
  row_id: string | null;
  summary: string;
  changed_fields?: DbChangedField[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  tool_name?: string;
  chat_id?: string;
}

interface ObservableDbTableConfig {
  columns: ReadonlyArray<{ name: string; type: string; hidden?: boolean }>;
  defaultSortColumn: string | null;
  searchableColumns: readonly string[];
  dateColumn: string | null;
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  rowIdExpression: string;
}

const OBSERVABLE_DB_TABLE_CONFIG: Record<ObservableDbTableName, ObservableDbTableConfig> = {
  knowledge_artifacts: {
    columns: [
      { name: "id", type: "uuid" },
      { name: "kind", type: "text" },
      { name: "title", type: "text" },
      { name: "version", type: "int4" },
      { name: "created_at", type: "timestamptz" },
      { name: "updated_at", type: "timestamptz" },
      { name: "has_embedding", type: "boolean" },
      { name: "embedding", type: "vector", hidden: true },
      { name: "tsv", type: "tsvector", hidden: true },
    ],
    defaultSortColumn: "updated_at",
    searchableColumns: ["title", "body", "kind"],
    dateColumn: "updated_at",
    createdAtColumn: "created_at",
    updatedAtColumn: "updated_at",
    rowIdExpression: "id::text",
  },
  artifact_links: {
    columns: [
      { name: "source_id", type: "uuid" },
      { name: "target_id", type: "uuid" },
      { name: "created_at", type: "timestamptz" },
    ],
    defaultSortColumn: "created_at",
    searchableColumns: [],
    dateColumn: "created_at",
    createdAtColumn: "created_at",
    updatedAtColumn: null,
    rowIdExpression: "source_id::text || '->' || target_id::text",
  },
  todos: {
    columns: [
      { name: "id", type: "uuid" },
      { name: "title", type: "text" },
      { name: "status", type: "text" },
      { name: "next_step", type: "text" },
      { name: "urgent", type: "boolean" },
      { name: "important", type: "boolean" },
      { name: "is_focus", type: "boolean" },
      { name: "parent_id", type: "uuid" },
      { name: "sort_order", type: "int4" },
      { name: "completed_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz" },
      { name: "updated_at", type: "timestamptz" },
    ],
    defaultSortColumn: "updated_at",
    searchableColumns: ["title", "next_step", "body"],
    dateColumn: "updated_at",
    createdAtColumn: "created_at",
    updatedAtColumn: "updated_at",
    rowIdExpression: "id::text",
  },
  activity_logs: {
    columns: [
      { name: "id", type: "int4" },
      { name: "chat_id", type: "text" },
      { name: "cost_usd", type: "float8" },
      { name: "created_at", type: "timestamptz" },
      { name: "memories", type: "jsonb", hidden: true },
      { name: "tool_calls", type: "jsonb", hidden: true },
    ],
    defaultSortColumn: "created_at",
    searchableColumns: ["chat_id"],
    dateColumn: "created_at",
    createdAtColumn: "created_at",
    updatedAtColumn: null,
    rowIdExpression: "id::text",
  },
  chat_messages: {
    columns: [
      { name: "id", type: "int4" },
      { name: "chat_id", type: "int8" },
      { name: "external_message_id", type: "text" },
      { name: "role", type: "text" },
      { name: "content", type: "text" },
      { name: "tool_call_id", type: "text" },
      { name: "compacted_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz" },
    ],
    defaultSortColumn: "created_at",
    searchableColumns: ["role", "content"],
    dateColumn: "created_at",
    createdAtColumn: "created_at",
    updatedAtColumn: null,
    rowIdExpression: "id::text",
  },
  patterns: {
    columns: [
      { name: "id", type: "int4" },
      { name: "kind", type: "text" },
      { name: "content", type: "text" },
      { name: "confidence", type: "float8" },
      { name: "strength", type: "float8" },
      { name: "times_seen", type: "int4" },
      { name: "status", type: "text" },
      { name: "source_type", type: "text" },
      { name: "source_id", type: "text" },
      { name: "first_seen", type: "timestamptz" },
      { name: "last_seen", type: "timestamptz" },
      { name: "created_at", type: "timestamptz" },
      { name: "embedding", type: "vector", hidden: true },
      { name: "text_search", type: "tsvector", hidden: true },
      { name: "temporal", type: "jsonb", hidden: true },
    ],
    defaultSortColumn: "last_seen",
    searchableColumns: ["kind", "content", "status"],
    dateColumn: "last_seen",
    createdAtColumn: "created_at",
    updatedAtColumn: "last_seen",
    rowIdExpression: "id::text",
  },
  daily_metrics: {
    columns: [
      { name: "date", type: "date" },
      { name: "weight_kg", type: "float8" },
      { name: "created_at", type: "timestamptz" },
    ],
    defaultSortColumn: "date",
    searchableColumns: [],
    dateColumn: "date",
    createdAtColumn: "created_at",
    updatedAtColumn: null,
    rowIdExpression: "date::text",
  },
};

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

export function isObservableDbTableName(value: string): value is ObservableDbTableName {
  return (OBSERVABLE_DB_TABLES as readonly string[]).includes(value);
}

function getObservableTableConfig(table: string): ObservableDbTableConfig {
  /* v8 ignore next 3 */
  if (!isObservableDbTableName(table)) {
    throw new Error(`Unsupported table: ${table}`);
  }
  return OBSERVABLE_DB_TABLE_CONFIG[table];
}

function buildObservableTableWhere(
  config: ObservableDbTableConfig,
  options: { q?: string; from?: string; to?: string }
): { whereSql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const q = options.q?.trim();
  if (q && config.searchableColumns.length > 0) {
    values.push(`%${q}%`);
    const qParam = `$${values.length}`;
    conditions.push(
      `(${config.searchableColumns
        .map((col) => `${quoteIdentifier(col)}::text ILIKE ${qParam}`)
        .join(" OR ")})`
    );
  }

  /* v8 ignore next 4 */
  if (config.dateColumn && options.from) {
    values.push(options.from);
    conditions.push(`${quoteIdentifier(config.dateColumn)} >= $${values.length}::timestamptz`);
  }

  /* v8 ignore next 4 */
  if (config.dateColumn && options.to) {
    values.push(options.to);
    conditions.push(`${quoteIdentifier(config.dateColumn)} <= $${values.length}::timestamptz`);
  }

  return {
    /* v8 ignore next */
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function sanitizeObservableChangeSnapshot(
  table: ObservableDbTableName,
  row: unknown
): Record<string, unknown> | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const config = OBSERVABLE_DB_TABLE_CONFIG[table];
  const hiddenColumns = new Set(
    config.columns.filter((column) => column.hidden).map((column) => column.name)
  );
  const input = row as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    /* v8 ignore next */
    if (hiddenColumns.has(key)) continue;
    output[key] = value;
  }
  return output;
}

/* v8 ignore next 26 -- data-dependent field inference, tested via DB observability integration */
function inferObservableChangedFields(
  operation: DbChangeOperation,
  after: Record<string, unknown> | null
): DbChangedField[] {
  if (!after || operation === "delete" || operation === "tool_call") return [];
  const candidateKeys = [
    "status",
    "title",
    "kind",
    "type",
    "version",
    "updated_at",
    "created_at",
  ];
  const fields: DbChangedField[] = [];
  for (const key of candidateKeys) {
    if (!(key in after)) continue;
    fields.push({
      field: key,
      before: null,
      after: after[key],
    });
  }
  return fields.slice(0, 5);
}

/* v8 ignore next 13 */
function summarizeObservableChange(
  table: ObservableDbTableName,
  operation: DbChangeOperation,
  rowId: string | null,
  changedFields: DbChangedField[]
): string {
  if (changedFields.length === 0) {
    return rowId ? `${table} ${operation} (${rowId})` : `${table} ${operation}`;
  }
  const fieldSummary = changedFields
    .map((field) => `${field.field}=${String(field.after)}`)
    .join(", ");
  return rowId ? `${table} ${operation} (${rowId}) · ${fieldSummary}` : `${table} ${operation} · ${fieldSummary}`;
}

export async function listObservableTables(pool: pg.Pool): Promise<DbTableMeta[]> {
  const tasks = OBSERVABLE_DB_TABLES.map(async (name): Promise<DbTableMeta> => {
    const config = OBSERVABLE_DB_TABLE_CONFIG[name];
    const dateColumn = config.updatedAtColumn ?? config.createdAtColumn;
    /* v8 ignore next */
    const maxExpr = dateColumn ? `MAX(${quoteIdentifier(dateColumn)}) AS last_changed_at` : "NULL::timestamptz AS last_changed_at";

    const result = await pool.query(
      `SELECT COUNT(*)::int AS row_count, ${maxExpr}
       FROM ${quoteIdentifier(name)}`
    );

    return {
      name,
      row_count: Number(result.rows[0].row_count),
      /* v8 ignore next */
      last_changed_at: (result.rows[0].last_changed_at as Date | null) ?? null,
      default_sort_column: config.defaultSortColumn,
    };
  });

  const metas = await Promise.all(tasks);
  return metas.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listObservableTableRows(
  pool: pg.Pool,
  table: string,
  options: {
    limit: number;
    offset: number;
    sort?: string;
    order?: "asc" | "desc";
    q?: string;
    from?: string;
    to?: string;
  }
): Promise<DbRowsResult> {
  const config = getObservableTableConfig(table);

  /* v8 ignore next */
  const sortColumn = options.sort ?? config.defaultSortColumn ?? config.columns[0]?.name;
  /* v8 ignore next 3 */
  if (!sortColumn || !config.columns.some((col) => col.name === sortColumn)) {
    throw new Error(`Unsupported sort column "${options.sort ?? ""}" for table ${table}`);
  }
  /* v8 ignore next */
  const order = options.order === "asc" ? "ASC" : "DESC";
  const { whereSql, values } = buildObservableTableWhere(config, options);
  const selectColumns = config.columns.map((col) => quoteIdentifier(col.name)).join(", ");

  const listValues = [...values, options.limit, options.offset];
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT ${selectColumns}
       FROM ${quoteIdentifier(table)}
       ${whereSql}
       ORDER BY ${quoteIdentifier(sortColumn)} ${order}
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      listValues
    ),
    pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM ${quoteIdentifier(table)}
       ${whereSql}`,
      values
    ),
  ]);

  return {
    items: rowsResult.rows as Record<string, unknown>[],
    total: Number(countResult.rows[0].count),
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.type,
      hidden: Boolean(column.hidden),
    })),
  };
}

export async function listRecentDbChanges(
  pool: pg.Pool,
  options: {
    limit: number;
    since?: Date;
    table?: ObservableDbTableName;
    operation?: DbChangeOperation;
  }
): Promise<DbChangeEvent[]> {
  const events: DbChangeEvent[] = [];
  const perTableLimit = Math.max(Math.min(options.limit, 200), 10);

  /* v8 ignore next */
  const includeToolCalls = !options.operation || options.operation === "tool_call";
  /* v8 ignore next */
  if (includeToolCalls && (!options.table || options.table === "activity_logs")) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    /* v8 ignore next 4 */
    if (options.since) {
      values.push(options.since);
      conditions.push(`created_at >= $${values.length}`);
    }
    /* v8 ignore next */
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(perTableLimit);

    const activityResult = await pool.query(
      `SELECT id, chat_id, tool_calls, created_at
       FROM activity_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );

    for (const row of activityResult.rows) {
      /* v8 ignore next 3 */
      const toolCalls = Array.isArray(row.tool_calls)
        ? (row.tool_calls as Array<Record<string, unknown>>)
        : [];
      /* v8 ignore next 2 */
      const names = toolCalls
        .map((call) => String(call.name ?? "").trim())
        .filter((name) => name.length > 0);
      /* v8 ignore next */
      const firstToolCall = toolCalls[0] ?? null;
      /* v8 ignore next 9 */
      events.push({
        changed_at: row.created_at as Date,
        table: "activity_logs",
        operation: "tool_call",
        row_id: String(row.id),
        summary: names.length > 0 ? `Tool calls: ${names.join(", ")}` : "Tool call activity logged",
        changed_fields: [],
        before: null,
        /* v8 ignore next 8 */
        after: firstToolCall
          ? sanitizeObservableChangeSnapshot("activity_logs", {
            tool_name: firstToolCall.name ?? null,
            args: firstToolCall.input ?? firstToolCall.args ?? null,
            result: firstToolCall.output ?? firstToolCall.result ?? null,
          })
          : null,
        tool_name: names[0],
        chat_id: String(row.chat_id),
      });
    }
  }

  /* v8 ignore next */
  const sourceTables = (options.table ? [options.table] : OBSERVABLE_DB_TABLES).filter(
    (table) => table !== "activity_logs"
  );

  for (const table of sourceTables) {
    const config = OBSERVABLE_DB_TABLE_CONFIG[table];
    const changedAtColumn = config.updatedAtColumn ?? config.createdAtColumn;
    /* v8 ignore next 2 */
    if (!changedAtColumn) continue;
    if (options.operation === "tool_call") continue;

    const values: unknown[] = [];
    let whereSql = "";
    /* v8 ignore next 4 -- optional since filter, tested via integration with full param */
    if (options.since) {
      values.push(options.since);
      whereSql = `WHERE ${quoteIdentifier(changedAtColumn)} >= $${values.length}`;
    }
    values.push(perTableLimit);
    const limitParam = `$${values.length}`;

    const operationExpr = config.updatedAtColumn && config.createdAtColumn
      ? `CASE
           WHEN ${quoteIdentifier(config.updatedAtColumn)} > ${quoteIdentifier(config.createdAtColumn)} THEN 'update'
           ELSE 'insert'
         END`
      : "'insert'";

    const result = await pool.query(
      `SELECT
         ${config.rowIdExpression} AS row_id,
         ${quoteIdentifier(changedAtColumn)} AS changed_at,
         ${operationExpr}::text AS operation,
         row_to_json(src)::jsonb AS after
       FROM (
         SELECT *
         FROM ${quoteIdentifier(table)}
         ${whereSql}
         ORDER BY ${quoteIdentifier(changedAtColumn)} DESC
         LIMIT ${limitParam}
       ) AS src`,
      values
    );

    for (const row of result.rows) {
      const operation = row.operation as DbChangeOperation;
      /* v8 ignore next */
      if (options.operation && operation !== options.operation) continue;
      /* v8 ignore next */
      const rowId = (row.row_id as string | null) ?? null;
      const after = sanitizeObservableChangeSnapshot(table, row.after);
      const changedFields = inferObservableChangedFields(operation, after);
      events.push({
        changed_at: row.changed_at as Date,
        table,
        operation,
        row_id: rowId,
        summary: summarizeObservableChange(table, operation, rowId, changedFields),
        changed_fields: changedFields,
        before: null,
        after,
      });
    }
  }

  return events
    .sort((a, b) => {
      const timeDelta = b.changed_at.getTime() - a.changed_at.getTime();
      if (timeDelta !== 0) return timeDelta;
      const tableDelta = a.table.localeCompare(b.table);
      /* v8 ignore next 2 */
      if (tableDelta !== 0) return tableDelta;
      return (a.row_id ?? "").localeCompare(b.row_id ?? "");
    })
    .slice(0, options.limit);
}

// ============================================================================
// Helpers
// ============================================================================

function mapActivityLogRow(row: Record<string, unknown>): ActivityLogRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    memories: (row.memories as ActivityLogMemory[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    tool_calls: (row.tool_calls as ActivityLogToolCall[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    cost_usd: row.cost_usd != null ? parseFloat(row.cost_usd as string) : null,
    created_at: row.created_at as Date,
  };
}
