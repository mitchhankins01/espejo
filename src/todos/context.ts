import type pg from "pg";
import { getFocusTodo, listTodos } from "../db/queries.js";

export async function buildTodoContextPrompt(pool: pg.Pool): Promise<string> {
  const [focus, doFirst, waitingResult, activeResult] = await Promise.all([
    getFocusTodo(pool),
    listTodos(pool, { urgent: true, important: true, status: "active", limit: 5, offset: 0 }),
    listTodos(pool, { status: "waiting", limit: 1, offset: 0 }),
    listTodos(pool, { status: "active", limit: 1, offset: 0 }),
  ]);

  const lines: string[] = [];

  if (focus) {
    lines.push(`The One Thing (focus): "${focus.title}"${focus.next_step ? ` — next: ${focus.next_step}` : ""}`);
  }

  if (doFirst.rows.length > 0) {
    const items = doFirst.rows
      .filter((t) => t.id !== focus?.id)
      .map((t) => `  - ${t.title}${t.next_step ? ` (next: ${t.next_step})` : ""}`)
      .join("\n");
    if (items) {
      lines.push(`Do First (urgent + important):\n${items}`);
    }
  }

  if (waitingResult.count > 0) {
    lines.push(`Waiting: ${waitingResult.count} item${waitingResult.count === 1 ? "" : "s"}`);
  }

  lines.push(`Active todos: ${activeResult.count}`);

  if (lines.length === 0) return "";

  return `Todo context:\n${lines.join("\n")}`;
}
