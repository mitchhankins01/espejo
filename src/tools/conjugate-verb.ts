import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getVerbConjugations } from "../db/queries.js";

function formatConjugationRow(
  row: Awaited<ReturnType<typeof getVerbConjugations>>[number]
): string {
  return [
    `<b>${row.mood} — ${row.tense}</b>${row.is_irregular ? " <i>(irregular)</i>" : ""}`,
    `yo: ${row.form_1s ?? "—"}`,
    `tú: ${row.form_2s ?? "—"}`,
    `él/ella/usted: ${row.form_3s ?? "—"}`,
    `nosotros: ${row.form_1p ?? "—"}`,
    `vosotros: ${row.form_2p ?? "—"}`,
    `ellos/ellas/ustedes: ${row.form_3p ?? "—"}`,
    `gerundio: ${row.gerund ?? "—"}`,
    `participio: ${row.past_participle ?? "—"}`,
  ].join("\n");
}

export async function handleConjugateVerb(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("conjugate_verb", input);
  const rows = await getVerbConjugations(pool, {
    verb: params.verb,
    mood: params.mood,
    tense: params.tense,
    limit: params.limit,
  });

  if (rows.length === 0) {
    return `No conjugations found for "${params.verb}".`;
  }

  const title = [`<b>Conjugations for ${rows[0].infinitive}</b>`];
  if (params.mood) title.push(`mood: ${params.mood}`);
  if (params.tense) title.push(`tense: ${params.tense}`);

  return `${title.join(" | ")}\n\n${rows.map(formatConjugationRow).join("\n\n")}`;
}

