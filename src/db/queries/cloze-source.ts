// Hybrid corpus lookup for cloze sentences. Tries vocab_reviews.examples first
// (Haiku-produced {en, es} pairs — short, clean, and translated), then falls
// through to knowledge_artifacts but ONLY kind='reference' (Tomos, external).
//
// Insights / reviews / notes / projects / journal-derived artifacts are
// deliberately excluded:
//   - insight: LLM-paraphrased English about Mitch's life ("Mitch has gone
//     three days without weed…") trivially matches `has`/`es`/`son` and
//     trains the user against English with a Spanish quiz attached.
//   - note: structurally heavy (YAML, bullets, headings) — Español Vivo
//     dumped its `common_traps:` YAML as a clue body.
//   - review/project: contain Mitch's own Spanish errors verbatim.
//
// Even within `reference` we post-filter: looksSpanish + not-structured +
// English-balance check.

import type pg from "pg";

export type ClozeHitSource = "examples" | "artifacts";

export interface ClozeHit {
  source: ClozeHitSource;
  sentence: string;
  /** English gloss, when available (vocab_reviews.examples carries {en,es}). */
  gloss: string | null;
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
  "soy","eres","somos","sois","son","está","están","están","estoy","estás",
  "estamos","estáis","ha","han","hemos","habéis","tengo","tienes","tiene",
  "tenemos","tenéis","tienen","ayer","hoy","mañana","todo","todos","toda",
  "todas","muchos","muchas","poco","poca","pocos","pocas","gente","casa",
  "vez","veces","años","año","día","días","tiempo","mundo","vida","mismo",
  "misma","otro","otra","otros","otras","cosa","cosas","mejor","peor",
]);

// English-only tokens used to fail-fast on English passages that happen to
// contain a Spanish form (e.g. "Mitch has gone three days without weed"
// matches `has`). Function words + the handful of insight-template phrases.
const ENGLISH_TOKENS = new Set([
  "the","and","is","was","were","are","be","been","being","have","had",
  "having","of","to","for","with","without","from","in","on","at","by",
  "this","that","these","those","an","a","or","but","not","no","so",
  "if","when","while","after","before","because","as","it","its","he",
  "she","they","them","their","his","her","you","your","we","our","us",
  "i","me","my","mine","yours","theirs","hers","him","what","which",
  "who","whom","whose","how","why","where","there","then","than","also",
  "just","very","really","get","got","go","goes","gone","going","came",
  "come","says","said","make","makes","made","take","takes","took",
  "would","could","should","might","will","won","can","cannot","does",
  "did","done","do","doing",
]);
const ACCENT_RE = /[áéíóúüñÁÉÍÓÚÜÑ¡¿]/;

export function looksSpanish(sentence: string): boolean {
  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let spanishSignals = ACCENT_RE.test(sentence) ? 1 : 0;
  let englishSignals = 0;
  for (const t of tokens) {
    if (SPANISH_TOKENS.has(t)) spanishSignals += 1;
    if (ENGLISH_TOKENS.has(t)) englishSignals += 1;
  }
  // Heavy English content (≥3 English-only tokens) AND ≤ Spanish signals →
  // reject. Pure Spanish sentences need ≥2 signals (typically accent + one
  // function token, or two function tokens).
  if (englishSignals >= 3 && englishSignals >= spanishSignals) return false;
  return spanishSignals >= 2;
}

/**
 * Reject segments that aren't prose: YAML mapping rows, bullet lists, table
 * pipes, headings, all-caps banners, code fences, blockquote panels with
 * attributed journal quotes. These leak through when an artifact body is
 * structured rather than narrative (e.g. Español Vivo's `common_traps:` YAML
 * block, or the `Thyroid History` reference's three-blockquote panel of dated
 * Day One quotes — see 2026-05-18 incident).
 */
export function looksStructured(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (!trimmed) return true;
  // YAML-ish: bare-key/value with no terminal punctuation, or a colon
  // immediately followed by a newline/dash. Either is a non-prose signal.
  if (/^[A-Za-z_][\w.-]*\s*:\s*$/.test(trimmed)) return true;
  if (/^\s*[-*•]\s+/.test(trimmed)) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (trimmed.startsWith("```")) return true;
  if (/^\s*\|.*\|\s*$/.test(trimmed)) return true; // markdown table row
  // Markdown blockquote markers — `>` at start of line means a quoted
  // passage. Tomos and references nest Day One excerpts this way, which
  // bypasses the "no journal-as-cloze" rule.
  if (/(^|\n)\s*>\s/.test(trimmed)) return true;
  // Citation date suffix attached to a journal-quote attribution
  // (`…esta semana"* — 2026-04-04`). These never belong inside a cloze.
  if (/—\s*\d{4}-\d{2}-\d{2}/.test(trimmed)) return true;
  // Attribution suffix `"* —` / `* —` / `'* —` that follows a quoted span.
  if (/["'][\s]*\*[\s]*—/.test(trimmed)) return true;
  // Lots of colons + few sentence-enders → config-ish (covers nested YAML).
  const colons = (trimmed.match(/:/g) ?? []).length;
  const enders = (trimmed.match(/[.!?]/g) ?? []).length;
  if (colons >= 3 && enders === 0) return true;
  // Newline-heavy = multi-line list/code rather than a sentence.
  const newlines = (trimmed.match(/\n/g) ?? []).length;
  if (newlines >= 2) return true;
  return false;
}

export function extractContaining(text: string, formLower: string): string | null {
  const segments = text.split(SPLIT_RE);
  for (const seg of segments) {
    // Don't cross paragraph boundaries. The sentence splitter doesn't honor
    // line breaks, so a segment can span an entire blockquote panel
    // (e.g. three dated Day One excerpts) when there's no `.` between them.
    // Take only the first line that actually contains the form.
    const formLine = seg
      .split(/\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.toLowerCase().includes(formLower));
    if (!formLine) continue;
    const out = formLine.length > SENTENCE_MAX_LEN
      ? formLine.slice(0, SENTENCE_MAX_LEN - 1).trimEnd() + "…"
      : formLine;
    return out;
  }
  return null;
}

interface RawHit {
  source: ClozeHitSource;
  sentence: string;
  gloss: string | null;
  cursor: string;
}

/**
 * Look up cloze candidates across vocab_reviews.examples and
 * knowledge_artifacts (kind='reference' only). Results are deduplicated,
 * looksSpanish-filtered, structure-filtered, and rotated by `reps` so the
 * same cell gets a fresh sentence across reviews.
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

  // vocab_reviews.examples: each row holds an `[{es,en}, …]` JSONB array of
  // Haiku-produced sentence/translation pairs. We need both so the result
  // render can show the English gloss on the reveal step (user feedback:
  // "how would I know any of these without translations").
  //
  // knowledge_artifacts: restricted to kind='reference' (Tomos, external
  // Spanish content). The other kinds carry the user's own writing or
  // English LLM paraphrases — see file-level comment.
  const result = await pool.query<RawHit>(
    `WITH form_pat AS (SELECT $1::text AS p)
     SELECT 'examples'::text AS source,
            ex->>'es'        AS sentence,
            ex->>'en'        AS gloss,
            vr.id::text      AS cursor
       FROM vocab_reviews vr,
            jsonb_array_elements(vr.examples) ex,
            form_pat
      WHERE LOWER(vr.stem) = $2 AND vr.lang=$3
        AND lower(ex->>'es') ~ form_pat.p
     UNION ALL
     SELECT 'artifacts'::text,
            ka.body,
            NULL::text,
            ka.id::text
       FROM knowledge_artifacts ka, form_pat
      WHERE ka.kind = 'reference'
        AND ka.body ~* form_pat.p
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
    if (looksStructured(sentence)) continue;
    if (row.source !== "examples" && !looksSpanish(sentence)) continue;
    const key = sentence.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push({
      source: row.source,
      sentence,
      gloss: row.source === "examples" ? row.gloss ?? null : null,
      cursor: row.cursor,
    });
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
