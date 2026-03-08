import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { listTodos } from "../db/queries.js";

export async function handleListTodos(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("list_todos", input);

  const { rows, count } = await listTodos(pool, {
    status: params.status,
    urgent: params.urgent,
    important: params.important,
    parent_id: params.parent_id,
    focus_only: params.focus_only,
    include_children: params.include_children,
    limit: params.limit,
    offset: params.offset,
  });

  if (rows.length === 0) {
    return "No todos found matching the given filters.";
  }

  return JSON.stringify({ items: rows, total: count }, null, 2);
}
