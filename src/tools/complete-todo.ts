import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { completeTodo } from "../db/queries.js";

export async function handleCompleteTodo(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("complete_todo", input);

  const todo = await completeTodo(pool, params.id);

  if (!todo) {
    return `No todo found with ID "${params.id}". Check that the ID is correct.`;
  }

  return JSON.stringify(todo, null, 2);
}
