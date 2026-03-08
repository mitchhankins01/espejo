import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { updateTodo } from "../db/queries.js";

export async function handleUpdateTodo(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("update_todo", input);

  const todo = await updateTodo(pool, params.id, {
    title: params.title,
    status: params.status,
    next_step: params.next_step,
    body: params.body,
    tags: params.tags,
    urgent: params.urgent,
    important: params.important,
  });

  if (!todo) {
    return `No todo found with ID "${params.id}". Check that the ID is correct.`;
  }

  return JSON.stringify(todo, null, 2);
}
