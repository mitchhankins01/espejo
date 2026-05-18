import type pg from "pg";
import type { CardStateName, Grade, NextCardState } from "../../fsrs/scheduler.js";

export interface VocabExample {
  es: string;
  en?: string;
}

export interface VocabReviewRow {
  id: string;
  stem: string;
  lang: string;
  gloss: string | null;
  gloss_override: string | null;
  pronunciation: string | null;
  examples: VocabExample[];
  sample_usage: string;
  sample_word: string;
  sample_source: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  lookups_count: number;
  status: "active" | "suspended";
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: CardStateName;
  learning_steps: number;
  last_review: Date | null;
  current_session_id: string | null;
  current_session_served_at: Date | null;
  current_session_rated_at: Date | null;
  chat_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertLookupParams {
  stem: string;
  lang: string;
  sampleUsage: string;
  sampleWord: string;
  sampleSource: string | null;
  lookedUpAt: Date;
}

/**
 * Idempotent upsert from import-lookups. Never touches FSRS state on conflict —
 * only `last_seen_at`, `lookups_count`, sample fields, and `updated_at`.
 */
export async function upsertLookup(
  pool: pg.Pool,
  params: UpsertLookupParams
): Promise<void> {
  await pool.query(
    `INSERT INTO vocab_reviews
       (stem, lang, sample_usage, sample_word, sample_source,
        first_seen_at, last_seen_at, lookups_count)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
     ON CONFLICT (LOWER(stem), lang) DO UPDATE SET
       last_seen_at  = GREATEST(vocab_reviews.last_seen_at, EXCLUDED.last_seen_at),
       lookups_count = vocab_reviews.lookups_count + 1,
       sample_usage  = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                            THEN EXCLUDED.sample_usage  ELSE vocab_reviews.sample_usage END,
       sample_word   = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                            THEN EXCLUDED.sample_word   ELSE vocab_reviews.sample_word END,
       sample_source = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                            THEN EXCLUDED.sample_source ELSE vocab_reviews.sample_source END,
       updated_at    = NOW()`,
    [
      params.stem,
      params.lang,
      params.sampleUsage,
      params.sampleWord,
      params.sampleSource,
      params.lookedUpAt,
    ]
  );
}

/**
 * Rows that need a Haiku enrichment pass — missing gloss, missing
 * pronunciation, or no examples yet. Used for both initial backfill and
 * upgrade passes after the schema gains new enrichment fields.
 */
export async function getRowsNeedingGloss(
  pool: pg.Pool,
  limit: number
): Promise<{ id: string; stem: string; lang: string; sample_usage: string }[]> {
  const result = await pool.query<{
    id: string;
    stem: string;
    lang: string;
    sample_usage: string;
  }>(
    `SELECT id::text, stem, lang, sample_usage
       FROM vocab_reviews
      WHERE status = 'active'
        AND (gloss IS NULL
             OR pronunciation IS NULL
             OR jsonb_array_length(examples) = 0)
      ORDER BY last_seen_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export interface GlossPack {
  gloss: string;
  pronunciation: string | null;
  examples: VocabExample[];
}

export async function setGlossPack(
  pool: pg.Pool,
  id: string,
  pack: GlossPack
): Promise<void> {
  await pool.query(
    `UPDATE vocab_reviews
        SET gloss         = $1,
            pronunciation = $2,
            examples      = $3::jsonb,
            updated_at    = NOW()
      WHERE id = $4`,
    [pack.gloss, pack.pronunciation, JSON.stringify(pack.examples), id]
  );
}

/**
 * Build the queue for a fresh session, capped at `totalCap` cards. Due cards
 * (oldest first) take priority; remainder filled with state='new' rows in
 * `first_seen_at` order.
 *
 * `/srs N` semantics: N is the TOTAL session length, not the new-card cap.
 * The earlier design uncapped due cards, which surfaced 30 cards for a
 * `/srs 10` when there were 20 due — the opposite of the user expectation.
 */
export async function getDueQueue(
  pool: pg.Pool,
  totalCap: number
): Promise<VocabReviewRow[]> {
  const dueResult = await pool.query<VocabReviewRow>(
    `SELECT * FROM vocab_reviews
      WHERE status = 'active' AND state <> 'new' AND due <= NOW()
      ORDER BY due ASC
      LIMIT $1`,
    [totalCap]
  );
  const remaining = totalCap - dueResult.rows.length;
  if (remaining <= 0) return dueResult.rows;
  const newResult = await pool.query<VocabReviewRow>(
    `SELECT * FROM vocab_reviews
      WHERE status = 'active' AND state = 'new'
      ORDER BY first_seen_at ASC
      LIMIT $1`,
    [remaining]
  );
  return [...dueResult.rows, ...newResult.rows];
}

/**
 * Mark a card as served in the current session. Idempotent within the same
 * session id — re-running with the same id is a no-op.
 */
export async function serveCard(
  pool: pg.Pool,
  params: { id: string; sessionId: string; chatId: string }
): Promise<void> {
  await pool.query(
    `UPDATE vocab_reviews
        SET current_session_id = $1,
            current_session_served_at = NOW(),
            current_session_rated_at = NULL,
            chat_id = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [params.sessionId, params.chatId, params.id]
  );
}

export interface RateCardParams {
  id: string;
  sessionId: string;
  rating: Grade;
  next: NextCardState;
  chatId: string;
}

/**
 * Race-safe rate. Returns true if the rate succeeded (row updated + log
 * inserted), false if the session_id doesn't match or the card has already
 * been rated in this session. The two operations run in a transaction so a
 * partial write can't leave the card rated without a log row.
 */
export async function rateCard(
  pool: pg.Pool,
  params: RateCardParams
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateResult = await client.query<{ id: string }>(
      `UPDATE vocab_reviews
          SET stability      = $1,
              difficulty     = $2,
              elapsed_days   = $3,
              scheduled_days = $4,
              reps           = reps + 1,
              lapses         = $5,
              state          = $6,
              learning_steps = $7,
              due            = $8,
              last_review    = NOW(),
              current_session_rated_at = NOW(),
              updated_at     = NOW()
        WHERE id = $9
          AND current_session_id = $10
          AND current_session_rated_at IS NULL
        RETURNING id`,
      [
        params.next.stability,
        params.next.difficulty,
        params.next.elapsed_days,
        params.next.scheduled_days,
        params.next.lapses,
        params.next.state,
        params.next.learning_steps,
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
      `INSERT INTO vocab_review_log
         (review_id, rating, state_before, state_after,
          stability_before, stability_after,
          difficulty_before, difficulty_after,
          elapsed_days, scheduled_days, session_id, chat_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        params.id,
        params.rating,
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

export async function getReviewById(
  pool: pg.Pool,
  id: string
): Promise<VocabReviewRow | null> {
  const result = await pool.query<VocabReviewRow>(
    `SELECT * FROM vocab_reviews WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export interface VocabState {
  stem: string;
  state: CardStateName;
  lapses: number;
  stability: number;
  last_review: Date | null;
}

const STALLING_LAPSES_THRESHOLD = 2;
const STALLING_WINDOW_DAYS = 30;
const MASTERED_STABILITY_DAYS = 30;

/**
 * Lookup vocab state by stem (lowercased). Returns a Map keyed by lowercased
 * stem. Used by the Tomo writer to annotate the recent-lookups block.
 */
export async function getVocabStateForStems(
  pool: pg.Pool,
  stems: string[]
): Promise<Map<string, VocabState>> {
  const map = new Map<string, VocabState>();
  if (stems.length === 0) return map;
  const result = await pool.query<{
    stem: string;
    state: CardStateName;
    lapses: number;
    stability: number;
    last_review: Date | null;
  }>(
    `SELECT stem, state, lapses, stability, last_review
       FROM vocab_reviews
      WHERE LOWER(stem) = ANY($1)`,
    [stems.map((s) => s.toLowerCase())]
  );
  for (const row of result.rows) {
    map.set(row.stem.toLowerCase(), {
      stem: row.stem,
      state: row.state,
      lapses: row.lapses,
      stability: row.stability,
      last_review: row.last_review,
    });
  }
  return map;
}

/**
 * Classify a vocab state into a tag the writer can use. `null` means no tag.
 */
export function classifyVocabState(
  state: VocabState | undefined,
  now: Date = new Date()
): { tag: "stalling" | "mastered"; detail: string } | null {
  if (!state) return null;
  if (state.state === "learning" || state.state === "relearning") {
    return { tag: "stalling", detail: `lapses=${state.lapses}` };
  }
  if (state.lapses >= STALLING_LAPSES_THRESHOLD && state.last_review) {
    const windowStart = new Date(
      now.getTime() - STALLING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    if (state.last_review > windowStart) {
      return { tag: "stalling", detail: `lapses=${state.lapses}` };
    }
  }
  if (state.state === "review" && state.stability >= MASTERED_STABILITY_DAYS) {
    return { tag: "mastered", detail: "stable" };
  }
  return null;
}

export interface SessionCounts {
  due: number;
  stalling: number;
  newCards: number;
}

export async function getSessionCounts(pool: pg.Pool): Promise<SessionCounts> {
  const dueResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vocab_reviews
      WHERE status='active' AND state <> 'new' AND due <= NOW()`
  );
  const stallingResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vocab_reviews
      WHERE status='active'
        AND (state IN ('learning','relearning')
             OR (lapses >= 2 AND last_review > NOW() - INTERVAL '30 days'))`
  );
  const newResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vocab_reviews
      WHERE status='active' AND state = 'new'`
  );
  return {
    due: Number(dueResult.rows[0]?.count ?? 0),
    stalling: Number(stallingResult.rows[0]?.count ?? 0),
    newCards: Number(newResult.rows[0]?.count ?? 0),
  };
}
