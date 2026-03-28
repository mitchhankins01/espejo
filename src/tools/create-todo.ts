import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { createTodo } from "../db/queries.js";

export async function handleCreateTodo(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("create_todo", input);

  const todo = await createTodo(pool, {
    title: params.title,
    status: params.status,
    next_step: params.next_step,
    body: params.body,
    urgent: params.urgent,
    important: params.important,
    parent_id: params.parent_id,
  });

  return JSON.stringify(todo, null, 2);
}
