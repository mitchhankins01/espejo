import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { buildMorningContext, buildEveningContext } from "../sessions/context.js";

export async function handleStartJournalSession(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("start_journal_session", input);

  const context =
    params.type === "morning"
      ? await buildMorningContext(pool, params.date)
      : await buildEveningContext(pool, params.date);

  return JSON.stringify(context, null, 2);
}
