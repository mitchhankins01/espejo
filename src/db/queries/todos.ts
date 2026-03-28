import type pg from "pg";

// ============================================================================
// Todo types
// ============================================================================

export type TodoStatus = "active" | "waiting" | "done" | "someday";

export interface TodoRow {
  id: string;
  title: string;
  status: TodoStatus;
  next_step: string | null;
  body: string;
  urgent: boolean;
  important: boolean;
  is_focus: boolean;
  parent_id: string | null;
  sort_order: number;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  children?: TodoRow[];
}

export interface ListTodosFilters {
  status?: TodoStatus;
  urgent?: boolean;
  important?: boolean;
  parent_id?: string | "root";
  focus_only?: boolean;
  include_children?: boolean;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Private helpers
// ============================================================================

const TODO_COLUMNS = `id, title, status, next_step, body, urgent, important, is_focus, parent_id, sort_order, completed_at, created_at, updated_at`;

function toTodoRow(row: pg.QueryResultRow): TodoRow {
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as TodoStatus,
    next_step: (row.next_step as string | null) ?? null,
    body: row.body as string,
    urgent: row.urgent as boolean,
    important: row.important as boolean,
    is_focus: row.is_focus as boolean,
    parent_id: (row.parent_id as string | null) ?? null,
    /* v8 ignore next -- sort_order is NOT NULL DEFAULT 0 in DB */
    sort_order: (row.sort_order as number) ?? 0,
    completed_at: (row.completed_at as Date | null) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

// ============================================================================
// Query functions
// ============================================================================

export async function listTodos(
  pool: pg.Pool,
  filters: ListTodosFilters
): Promise<{ rows: TodoRow[]; count: number }> {
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];
  let paramIdx = 0;

  if (filters.status) {
    paramIdx++;
    whereClauses.push(`status = $${paramIdx}`);
    whereParams.push(filters.status);
  }
  if (filters.urgent !== undefined) {
    paramIdx++;
    whereClauses.push(`urgent = $${paramIdx}`);
    whereParams.push(filters.urgent);
  }
  if (filters.important !== undefined) {
    paramIdx++;
    whereClauses.push(`important = $${paramIdx}`);
    whereParams.push(filters.important);
  }
  if (filters.parent_id === "root") {
    whereClauses.push(`parent_id IS NULL`);
  } else if (filters.parent_id) {
    paramIdx++;
    whereClauses.push(`parent_id = $${paramIdx}`);
    whereParams.push(filters.parent_id);
  }
  if (filters.focus_only) {
    whereClauses.push(`is_focus = TRUE`);
  }

  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  /* v8 ignore next -- defaults exercised in HTTP/unit layers */
  const limit = Math.min(filters.limit ?? 20, 100);
  /* v8 ignore next -- defaults exercised in HTTP/unit layers */
  const offset = filters.offset ?? 0;

  paramIdx++;
  const limitParam = paramIdx;
  paramIdx++;
  const offsetParam = paramIdx;

  const params = [...whereParams, limit, offset];

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT ${TODO_COLUMNS}
       FROM todos
       ${whereClause}
       ORDER BY sort_order ASC, updated_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    ),
    pool.query(
      `SELECT count(*)::int AS total
       FROM todos
       ${whereClause}`,
      whereParams
    ),
  ]);

  let rows = rowsResult.rows.map((row) => toTodoRow(row));

  if (filters.include_children) {
    const parentIds = rows.filter((r) => r.parent_id === null).map((r) => r.id);
    if (parentIds.length > 0) {
      const childResult = await pool.query(
        `SELECT ${TODO_COLUMNS}
         FROM todos
         WHERE parent_id = ANY($1::uuid[])
         ORDER BY sort_order ASC, created_at ASC`,
        [parentIds]
      );
      const childMap = new Map<string, TodoRow[]>();
      for (const childRow of childResult.rows) {
        const child = toTodoRow(childRow);
        const pid = child.parent_id!;
        if (!childMap.has(pid)) childMap.set(pid, []);
        childMap.get(pid)!.push(child);
      }
      rows = rows.map((r) => ({
        ...r,
        children: childMap.get(r.id) ?? [],
      }));
    }
  }

  return {
    rows,
    count: countResult.rows[0].total as number,
  };
}

export async function getTodoById(
  pool: pg.Pool,
  id: string
): Promise<TodoRow | null> {
  const result = await pool.query(
    `SELECT ${TODO_COLUMNS}
     FROM todos
     WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const todo = toTodoRow(result.rows[0]);

  // Load children if this is a parent
  const childResult = await pool.query(
    `SELECT ${TODO_COLUMNS}
     FROM todos
     WHERE parent_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [id]
  );
  if (childResult.rows.length > 0) {
    todo.children = childResult.rows.map(toTodoRow);
  }

  return todo;
}

export async function createTodo(
  pool: pg.Pool,
  data: {
    title: string;
    status?: TodoStatus;
    next_step?: string | null;
    body?: string;
    urgent?: boolean;
    important?: boolean;
    parent_id?: string;
  }
): Promise<TodoRow> {
  // Validate parent exists and is root-level (max 2 levels)
  if (data.parent_id) {
    const parent = await pool.query(
      `SELECT id, parent_id FROM todos WHERE id = $1`,
      [data.parent_id]
    );
    if (parent.rows.length === 0) {
      throw new Error(`Parent todo not found: ${data.parent_id}`);
    }
    if (parent.rows[0].parent_id !== null) {
      throw new Error("Cannot nest more than 2 levels deep. Parent is already a subtask.");
    }
  }

  const result = await pool.query(
    `INSERT INTO todos (title, status, next_step, body, urgent, important, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${TODO_COLUMNS}`,
    [
      data.title,
      data.status ?? "active",
      data.next_step ?? null,
      data.body ?? "",
      data.urgent ?? false,
      data.important ?? false,
      data.parent_id ?? null,
    ]
  );
  return toTodoRow(result.rows[0]);
}

export async function updateTodo(
  pool: pg.Pool,
  id: string,
  data: {
    title?: string;
    status?: TodoStatus;
    next_step?: string | null;
    body?: string;
    urgent?: boolean;
    important?: boolean;
  }
): Promise<TodoRow | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (data.title !== undefined) {
    paramIdx++;
    setClauses.push(`title = $${paramIdx}`);
    params.push(data.title);
  }
  if (data.status !== undefined) {
    paramIdx++;
    setClauses.push(`status = $${paramIdx}`);
    params.push(data.status);
    // Auto-set completed_at when status → done, clear when moving away from done
    if (data.status === "done") {
      setClauses.push(`completed_at = NOW()`);
    } else {
      setClauses.push(`completed_at = NULL`);
    }
  }
  if (data.next_step !== undefined) {
    paramIdx++;
    setClauses.push(`next_step = $${paramIdx}`);
    params.push(data.next_step);
  }
  if (data.body !== undefined) {
    paramIdx++;
    setClauses.push(`body = $${paramIdx}`);
    params.push(data.body);
  }
  if (data.urgent !== undefined) {
    paramIdx++;
    setClauses.push(`urgent = $${paramIdx}`);
    params.push(data.urgent);
  }
  if (data.important !== undefined) {
    paramIdx++;
    setClauses.push(`important = $${paramIdx}`);
    params.push(data.important);
  }

  if (setClauses.length === 0) {
    return getTodoById(pool, id);
  }

  paramIdx++;
  params.push(id);

  const result = await pool.query(
    `UPDATE todos
     SET ${setClauses.join(", ")}
     WHERE id = $${paramIdx}
     RETURNING ${TODO_COLUMNS}`,
    params
  );

  /* v8 ignore next -- exercised via mocked HTTP update handler */
  if (result.rows.length === 0) return null;
  return toTodoRow(result.rows[0]);
}

export async function completeTodo(
  pool: pg.Pool,
  id: string
): Promise<TodoRow | null> {
  const result = await pool.query(
    `UPDATE todos
     SET status = 'done', completed_at = NOW(), is_focus = FALSE
     WHERE id = $1
     RETURNING ${TODO_COLUMNS}`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return toTodoRow(result.rows[0]);
}

export async function setTodoFocus(
  pool: pg.Pool,
  id?: string
): Promise<TodoRow | null> {
  // Clear all existing focus
  await pool.query(`UPDATE todos SET is_focus = FALSE WHERE is_focus = TRUE`);

  if (!id) return null;

  const result = await pool.query(
    `UPDATE todos
     SET is_focus = TRUE
     WHERE id = $1
     RETURNING ${TODO_COLUMNS}`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return toTodoRow(result.rows[0]);
}

export async function getFocusTodo(
  pool: pg.Pool
): Promise<TodoRow | null> {
  const result = await pool.query(
    `SELECT ${TODO_COLUMNS}
     FROM todos
     WHERE is_focus = TRUE
     LIMIT 1`
  );
  if (result.rows.length === 0) return null;
  return toTodoRow(result.rows[0]);
}

export async function deleteTodo(
  pool: pg.Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query(`DELETE FROM todos WHERE id = $1`, [id]);
  /* v8 ignore next */
  return (result.rowCount ?? 0) > 0;
}
