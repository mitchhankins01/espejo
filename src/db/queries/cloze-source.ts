// Hybrid corpus lookup for cloze sentences. Tries vocab_reviews.examples
// first (already short Spanish examples), then entries.text and
// knowledge_artifacts.body. App code post-filters with looksSpanish to keep
// English homographs from polluting results.

import type pg from "pg";

export type ClozeHitSource = "examples" | "artifacts";

export interface ClozeHit {
  source: ClozeHitSource;
  sentence: string;
  cursor: string;
}

export interface FindClozeParams {
  lemma: string;
  lang: string;
  form: string;
  tense?: string;
  /** Used to rotate through candidates across reviews of the same cell. */
  reps?: number;
  /** Hard cap on returned hits; defaults to 1. */
  limit?: number;
}

const SENTENCE_MAX_LEN = 140;
const SPLIT_RE = /[.!?¡¿…]+/;

// Cheap Spanish-context heuristic. Used to reject English homograph hits like
// "the modern era" when searching for `era`. Examples coming directly from
// vocab_reviews bypass this filter.
const SPANISH_TOKENS = new Set([
  "el","la","los","las","un","una","unos","unas","que","de","del","en",
  "por","para","con","no","se","me","te","lo","le","y","pero","o",
  "cuando","porque","como","si","es","ser","estar","fue","muy","más",
  "ya","sin","aquí","allí","ahí","entre","sobre","desde","hasta","hace",
  "qué","quién","cuál","cuándo","cómo","dónde","ahora","sí","mi","tu","su",
]);
const ACCENT_RE = /[áéíóúüñÁÉÍÓÚÜÑ¡¿]/;

export function looksSpanish(sentence: string): boolean {
  let signals = 0;
  if (ACCENT_RE.test(sentence)) signals += 1;
  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (SPANISH_TOKENS.has(t)) signals += 1;
    if (signals >= 2) return true;
  }
  return signals >= 2;
}

export function extractContaining(text: string, formLower: string): string | null {
  const segments = text.split(SPLIT_RE);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase().includes(formLower)) {
      const out = trimmed.length > SENTENCE_MAX_LEN
        ? trimmed.slice(0, SENTENCE_MAX_LEN - 1).trimEnd() + "…"
        : trimmed;
      return out;
    }
  }
  return null;
}

/**
 * Look up cloze candidates across vocab_reviews.examples, entries.text, and
 * knowledge_artifacts.body. Returns deduplicated, looksSpanish-filtered hits
 * rotated by `reps` so the same cell gets a fresh sentence across reviews.
 *
 * imperative_negative anchors on `no <form>` so "Quiero que hables" doesn't
 * surface as a negative-command frame.
 */
export async function findClozeSentence(
  pool: pg.Pool,
  params: FindClozeParams
): Promise<ClozeHit | null> {
  const { lemma, lang, form, tense, reps = 0 } = params;
  const limit = params.limit ?? 1;
  const formLower = form.toLowerCase();
  const isImpNeg = tense === "imperative_negative";

  // Escape regex metacharacters in the form before embedding into the PG regex.
  const escapedForm = formLower.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
  const innerPattern = isImpNeg
    ? `no\\s+${escapedForm}`
    : escapedForm;
  const fullPattern = `(^|[^a-záéíóúüñ])${innerPattern}([^a-záéíóúüñ]|$)`;

  // Entries (Day One journal) are deliberately excluded — they contain
  // Mitch's own Spanish, complete with the grammatical slips a drill is
  // supposed to correct. Sourcing cloze sentences from there would test the
  // user against their own mistakes. Keep curated content only: Haiku-
  // generated `vocab_reviews.examples` and vault `knowledge_artifacts`
  // (Tomos, References — LLM-written or external).
  const result = await pool.query<{ source: ClozeHitSource; sentence: string; cursor: string }>(
    `WITH form_pat AS (SELECT $1::text AS p)
     SELECT 'examples' AS source, ex->>'es' AS sentence, vr.id::text AS cursor
       FROM vocab_reviews vr,
            jsonb_array_elements(vr.examples) ex,
            form_pat
      WHERE LOWER(vr.stem) = $2 AND vr.lang=$3
        AND lower(ex->>'es') ~ form_pat.p
     UNION ALL
     SELECT 'artifacts', ka.body, ka.id::text
       FROM knowledge_artifacts ka, form_pat
      WHERE ka.body ~* form_pat.p
        AND ka.deleted_at IS NULL
     LIMIT 50`,
    [fullPattern, lemma.toLowerCase(), lang]
  );

  // App-side filter + sentence extraction.
  const seen = new Set<string>();
  const filtered: ClozeHit[] = [];
  // examples first
  const ordered = [...result.rows].sort((a, b) => {
    if (a.source === "examples" && b.source !== "examples") return -1;
    if (a.source !== "examples" && b.source === "examples") return 1;
    return 0;
  });

  // The form-with-leading-no contract: when searching imperative_negative we
  // matched "no hables"; the masker frame later renders `no ___` so we strip
  // the leading "no " here before deduplicating.
  for (const row of ordered) {
    let sentence: string | null;
    if (row.source === "examples") {
      // examples are already sentence-shaped
      const trimmed = row.sentence.trim();
      sentence = trimmed.length > SENTENCE_MAX_LEN
        ? trimmed.slice(0, SENTENCE_MAX_LEN - 1).trimEnd() + "…"
        : trimmed;
    } else {
      const needle = isImpNeg ? `no ${formLower}` : formLower;
      sentence = extractContaining(row.sentence, needle);
    }
    if (!sentence) continue;
    if (row.source !== "examples" && !looksSpanish(sentence)) continue;
    const key = sentence.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push({ source: row.source, sentence, cursor: row.cursor });
  }

  if (filtered.length === 0) return null;
  const idx = reps % filtered.length;
  if (limit === 1) return filtered[idx];
  // For limit > 1, return up to `limit` rotated starting from idx.
  // (Not used by the flow today; kept for completeness.)
  const out = [];
  for (let i = 0; i < Math.min(limit, filtered.length); i++) {
    out.push(filtered[(idx + i) % filtered.length]);
  }
  return out[0];
}
