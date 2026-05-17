// Mirrors the shape of vocab-reviews.ts but per (lemma,tense,person) cell.
// Lazy promotion: rows are inserted on first session that selects the cell;
// before that the candidate lives only in `conjugations`.

import type pg from "pg";
import type {
  CardStateName,
  Grade,
  NextCardState,
} from "../../fsrs/scheduler.js";

export interface ConjugationReviewRow {
  id: string;
  lemma: string;
  tense: string;
  person: string;
  expected_form: string;
  pattern: string;
  generated_sentence: string | null;
  generated_form: string | null;
  generated_gloss: string | null;
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: CardStateName;
  last_review: Date | null;
  current_session_id: string | null;
  current_session_served_at: Date | null;
  current_session_rated_at: Date | null;
  chat_id: string | null;
  status: "active" | "suspended";
  frequency_rank: number | null;
  created_at: Date;
  updated_at: Date;
}

const ROW_SELECT = `
  SELECT cr.id::text, cr.lemma, cr.tense, cr.person, cr.expected_form, cr.pattern,
         cr.generated_sentence, cr.generated_form, cr.generated_gloss,
         cr.due, cr.stability, cr.difficulty, cr.elapsed_days, cr.scheduled_days,
         cr.reps, cr.lapses, cr.state, cr.last_review,
         cr.current_session_id::text, cr.current_session_served_at, cr.current_session_rated_at,
         cr.chat_id, cr.status,
         c.frequency_rank,
         cr.created_at, cr.updated_at
  FROM conjugation_reviews cr
  LEFT JOIN conjugations c
    ON c.lemma = cr.lemma AND c.tense = cr.tense AND c.person = cr.person
`;

/**
 * Cold-start bucket priority: small irregular sets seed first so huge regular
 * buckets don't dominate on day one. Mirrors CONJ_PATTERN_BOOTSTRAP_ORDER in
 * specs/2026-05-15-conjugation-flow.md.
 */
const PATTERN_BOOTSTRAP_VALUES = [
  "('present_irregular',1)",
  "('present_yo_go',2)",
  "('present_stem_eie',3)",
  "('present_stem_oue',4)",
  "('present_stem_ei',5)",
  "('present_regular_ar',6)",
  "('present_regular_er',7)",
  "('present_regular_ir',8)",
  "('present_yo_zco',9)",
  "('present_perfect',10)",
  "('preterite_strong',11)",
  "('preterite_regular_ar',12)",
  "('preterite_regular_er_ir',13)",
  "('preterite_stem_iu',14)",
  "('imperfect_irregular',15)",
  "('imperfect_regular',16)",
  "('present_subj_irregular',17)",
  "('present_subj_yo_irreg_derived',18)",
  "('present_subj_regular',19)",
  "('imperative_affirmative_tu_irreg',20)",
  "('imperative_affirmative_regular',21)",
  "('imperative_negative',22)",
  "('future_irregular_stem',23)",
  "('future_regular',24)",
  "('conditional_irregular_stem',25)",
  "('conditional_regular',26)",
  "('pluperfect',27)",
  "('present_perfect_subj',28)",
  "('imperfect_subj_strong_stem',29)",
  "('imperfect_subj_regular',30)",
  "('conditional_perfect',31)",
  "('future_perfect',32)",
  "('pluperfect_subj',33)",
].join(", ");

/**
 * Pick the pattern for this session. Existing-reviews path wins on most-due,
 * then highest miss rate, then least-recently-drilled. Cold start falls
 * through to the bootstrap order so common irregular patterns seed first.
 */
export async function pickPatternForSession(
  pool: pg.Pool
): Promise<string | null> {
  const due = await pool.query<{ pattern: string }>(
    `WITH per_pattern AS (
       SELECT pattern,
              COUNT(*) FILTER (WHERE due <= NOW() AND state <> 'new') AS due_count,
              COUNT(*) FILTER (WHERE state = 'new') AS new_count,
              AVG(lapses) AS miss,
              MAX(last_review) AS most_recent
         FROM conjugation_reviews
        WHERE status='active'
        GROUP BY pattern
     )
     SELECT pattern FROM per_pattern
      WHERE due_count + new_count > 0
      ORDER BY due_count DESC, miss DESC NULLS LAST, most_recent ASC NULLS FIRST, pattern ASC
      LIMIT 1`
  );
  if (due.rows[0]?.pattern) return due.rows[0].pattern;

  const cold = await pool.query<{ pattern: string }>(
    `WITH pattern_priority(pattern, priority) AS (
       VALUES ${PATTERN_BOOTSTRAP_VALUES}
     )
     SELECT c.pattern
       FROM conjugations c
       JOIN pattern_priority pp ON pp.pattern = c.pattern
       LEFT JOIN conjugation_reviews cr
         ON cr.lemma = c.lemma AND cr.tense = c.tense AND cr.person = c.person
      WHERE cr.id IS NULL
        AND c.frequency_rank IS NOT NULL
      GROUP BY c.pattern, pp.priority
      ORDER BY pp.priority ASC, MIN(c.frequency_rank) ASC, c.pattern ASC
      LIMIT 1`
  );
  return cold.rows[0]?.pattern ?? null;
}

/**
 * Build the session queue from a chosen pattern: existing due cells first,
 * then existing new cells, then lazy-promote unpromoted candidates ordered
 * by frequency_rank. Returns review_ids in serve order.
 */
export async function buildConjugationQueue(
  pool: pg.Pool,
  pattern: string,
  cap: number
): Promise<string[]> {
  const ids: string[] = [];
  // (1) existing due cells
  const due = await pool.query<{ id: string }>(
    `SELECT id::text FROM conjugation_reviews
      WHERE status='active' AND pattern=$1 AND state <> 'new' AND due <= NOW()
      ORDER BY due ASC
      LIMIT $2`,
    [pattern, cap]
  );
  ids.push(...due.rows.map((r) => r.id));

  let remaining = cap - ids.length;
  if (remaining <= 0) return ids;

  // (2) existing new-state cells
  const news = await pool.query<{ id: string }>(
    `SELECT id::text FROM conjugation_reviews
      WHERE status='active' AND pattern=$1 AND state='new'
      ORDER BY id ASC
      LIMIT $2`,
    [pattern, remaining]
  );
  ids.push(...news.rows.map((r) => r.id));

  remaining = cap - ids.length;
  if (remaining <= 0) return ids;

  // (3) promote unpromoted candidates
  const promote = await pool.query<{ id: string }>(
    `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern)
     SELECT c.lemma, c.tense, c.person, c.form, c.pattern
       FROM conjugations c
       LEFT JOIN conjugation_reviews cr
         ON cr.lemma=c.lemma AND cr.tense=c.tense AND cr.person=c.person
      WHERE c.pattern=$1 AND cr.id IS NULL
      ORDER BY c.frequency_rank NULLS LAST, c.lemma, c.tense, c.person
      LIMIT $2
     ON CONFLICT (lemma, tense, person) DO NOTHING
     RETURNING id::text`,
    [pattern, remaining]
  );
  ids.push(...promote.rows.map((r) => r.id));

  return ids;
}

export async function getConjugationReviewById(
  pool: pg.Pool,
  id: string
): Promise<ConjugationReviewRow | null> {
  const result = await pool.query<ConjugationReviewRow>(
    `${ROW_SELECT} WHERE cr.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Mark a card as served in the current session.
 */
export async function serveConjugationCard(
  pool: pg.Pool,
  params: { id: string; sessionId: string; chatId: string }
): Promise<void> {
  await pool.query(
    `UPDATE conjugation_reviews
        SET current_session_id = $1,
            current_session_served_at = NOW(),
            current_session_rated_at = NULL,
            chat_id = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [params.sessionId, params.chatId, params.id]
  );
}

export async function cacheGeneratedSentence(
  pool: pg.Pool,
  id: string,
  sentence: string,
  form: string,
  gloss: string | null
): Promise<void> {
  await pool.query(
    `UPDATE conjugation_reviews
        SET generated_sentence = $1,
            generated_form     = $2,
            generated_gloss    = $3,
            updated_at         = NOW()
      WHERE id = $4`,
    [sentence, form, gloss, id]
  );
}

export type GradeKind =
  | "exact"
  | "wrong"
  | "easy"
  | "hint_correct"
  | "hint_wrong"
  | "hint_easy";

export type ClozeSource = "corpus" | "generated";

export interface RateConjugationParams {
  id: string;
  sessionId: string;
  rating: Grade;
  gradeKind: GradeKind;
  typedAnswer: string | null;
  hintUsed: boolean;
  clozeSource: ClozeSource;
  next: NextCardState;
  chatId: string;
}

/**
 * Race-safe rate. Same UPDATE + transactional log insert pattern as
 * `vocab_reviews.rateCard`, with extra fields for grade_kind / typed_answer /
 * hint_used / cloze_source.
 */
export async function rateConjugationCard(
  pool: pg.Pool,
  params: RateConjugationParams
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateResult = await client.query<{ id: string }>(
      `UPDATE conjugation_reviews
          SET stability=$1, difficulty=$2, elapsed_days=$3, scheduled_days=$4,
              reps=reps+1, lapses=$5, state=$6, due=$7,
              last_review=NOW(),
              current_session_rated_at=NOW(),
              updated_at=NOW()
        WHERE id=$8 AND current_session_id=$9 AND current_session_rated_at IS NULL
        RETURNING id`,
      [
        params.next.stability,
        params.next.difficulty,
        params.next.elapsed_days,
        params.next.scheduled_days,
        params.next.lapses,
        params.next.state,
        params.next.due,
        params.id,
        params.sessionId,
      ]
    );
    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO conjugation_review_log
         (review_id, rating, grade_kind, typed_answer, hint_used, cloze_source,
          state_before, state_after,
          stability_before, stability_after,
          difficulty_before, difficulty_after,
          elapsed_days, scheduled_days, session_id, chat_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        params.id,
        params.rating,
        params.gradeKind,
        params.typedAnswer,
        params.hintUsed,
        params.clozeSource,
        params.next.state_before,
        params.next.state,
        params.next.stability_before,
        params.next.stability,
        params.next.difficulty_before,
        params.next.difficulty,
        params.next.elapsed_days,
        params.next.scheduled_days,
        params.sessionId,
        params.chatId,
      ]
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ConjugationSessionCounts {
  due: number;
  stalling: number;
  unpromoted: number;
}

/**
 * Cross-pattern session counts for the end-of-session summary.
 */
export async function getConjugationSessionCounts(
  pool: pg.Pool
): Promise<ConjugationSessionCounts> {
  const dueResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conjugation_reviews
      WHERE status='active' AND state<>'new' AND due <= NOW()`
  );
  const stallingResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conjugation_reviews
      WHERE status='active'
        AND (state IN ('learning','relearning')
             OR (lapses >= 2 AND last_review > NOW() - INTERVAL '30 days'))`
  );
  const unpromotedResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conjugations c
       LEFT JOIN conjugation_reviews cr
         ON cr.lemma=c.lemma AND cr.tense=c.tense AND cr.person=c.person
      WHERE cr.id IS NULL AND c.frequency_rank IS NOT NULL`
  );
  return {
    due: Number(dueResult.rows[0]?.count ?? 0),
    stalling: Number(stallingResult.rows[0]?.count ?? 0),
    unpromoted: Number(unpromotedResult.rows[0]?.count ?? 0),
  };
}

export interface PatternBucketCount {
  pattern: string;
  promoted: number;
  due: number;
}

export async function getPatternBucketCounts(
  pool: pg.Pool
): Promise<PatternBucketCount[]> {
  const result = await pool.query<{
    pattern: string;
    promoted: string;
    due: string;
  }>(
    `SELECT pattern,
            COUNT(*)::text AS promoted,
            COUNT(*) FILTER (WHERE due <= NOW() AND state<>'new')::text AS due
       FROM conjugation_reviews
      WHERE status='active'
      GROUP BY pattern
      ORDER BY pattern`
  );
  return result.rows.map((r) => ({
    pattern: r.pattern,
    promoted: Number(r.promoted),
    due: Number(r.due),
  }));
}
