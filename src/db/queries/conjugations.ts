// Read-only queries against the vendored `conjugations` table. The table is
// populated by `pnpm import:conjugations` and never written by runtime code.

import type pg from "pg";

export interface ConjugationCell {
  id: string;
  lemma: string;
  tense: string;
  person: string;
  form: string;
  pattern: string;
  source_template: string | null;
  frequency_rank: number | null;
}

export async function getConjugation(
  pool: pg.Pool,
  lemma: string,
  tense: string,
  person: string
): Promise<ConjugationCell | null> {
  const result = await pool.query<ConjugationCell>(
    `SELECT id::text, lemma, tense, person, form, pattern, source_template, frequency_rank
       FROM conjugations
      WHERE lemma=$1 AND tense=$2 AND person=$3`,
    [lemma, tense, person]
  );
  return result.rows[0] ?? null;
}

export async function getCellsForLemma(
  pool: pg.Pool,
  lemma: string
): Promise<ConjugationCell[]> {
  const result = await pool.query<ConjugationCell>(
    `SELECT id::text, lemma, tense, person, form, pattern, source_template, frequency_rank
       FROM conjugations
      WHERE lemma=$1
      ORDER BY tense, person`,
    [lemma]
  );
  return result.rows;
}

/**
 * Return all 6 person→form cells for a single (lemma, tense). Used by
 * paradigm-peek hints for fully-irregular families where listing the
 * paradigm with the asked slot blanked is more useful than "recall it".
 */
export async function getParadigm(
  pool: pg.Pool,
  lemma: string,
  tense: string
): Promise<Array<{ person: string; form: string }>> {
  const result = await pool.query<{ person: string; form: string }>(
    `SELECT person, form
       FROM conjugations
      WHERE lemma=$1 AND tense=$2
      ORDER BY CASE person
        WHEN 'yo' THEN 1
        WHEN 'tu' THEN 2
        WHEN 'el' THEN 3
        WHEN 'nosotros' THEN 4
        WHEN 'vosotros' THEN 5
        WHEN 'ellos' THEN 6
        ELSE 7
      END`,
    [lemma, tense]
  );
  return result.rows;
}

export async function getCellsByPattern(
  pool: pg.Pool,
  pattern: string,
  limit: number
): Promise<ConjugationCell[]> {
  const result = await pool.query<ConjugationCell>(
    `SELECT id::text, lemma, tense, person, form, pattern, source_template, frequency_rank
       FROM conjugations
      WHERE pattern=$1
      ORDER BY frequency_rank NULLS LAST, lemma, tense, person
      LIMIT $2`,
    [pattern, limit]
  );
  return result.rows;
}

export async function countCellsPerPattern(
  pool: pg.Pool
): Promise<{ pattern: string; cells: number }[]> {
  const result = await pool.query<{ pattern: string; cells: string }>(
    `SELECT pattern, COUNT(*)::text AS cells
       FROM conjugations
      GROUP BY pattern
      ORDER BY pattern`
  );
  return result.rows.map((r) => ({
    pattern: r.pattern,
    cells: Number(r.cells),
  }));
}
