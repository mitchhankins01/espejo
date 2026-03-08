import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { setTodoFocus } from "../db/queries.js";

export async function handleSetTodoFocus(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("set_todo_focus", input);

  if (params.clear) {
    await setTodoFocus(pool);
    return "Focus cleared. No todo is currently marked as The One Thing.";
  }

  if (!params.id) {
    return "Provide an id to set focus, or clear=true to clear the current focus.";
  }

  const todo = await setTodoFocus(pool, params.id);

  if (!todo) {
    return `No todo found with ID "${params.id}". Check that the ID is correct.`;
  }

  return JSON.stringify({ message: "Focus set", todo }, null, 2);
}
