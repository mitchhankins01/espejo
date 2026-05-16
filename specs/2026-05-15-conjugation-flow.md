---
status: planned
author: Mitch + Claude
date: 2026-05-15
---

# `/conj` — Telegram-driven Spanish conjugation drill (typed cloze, pattern-batched)

## Problem

`/srs` works for vocabulary recall but is the wrong shape for conjugation. Spaced repetition over `(verb, tense, person) → form` cells in isolation is by construction a paradigm-table grind — what Mitch called "rote and useless." Ella Verbs proves the surface can feel different when sessions are **batched by shared conjugation pattern** and answers are **typed into real sentences** rather than tap-to-reveal. We have one asymmetry Ella doesn't: Mitch's own corpus — Tomos, Día Uno entries, Day One journal, Kindle excerpts — so cloze sentences come from text he has *actually written or read*, not generic textbook examples.

This spec adds a Telegram `/conj` flow that drills typed Spanish conjugation cloze, one shared pattern per session, FSRS-scheduled per `(lemma, tense, person)` cell, mirroring the operational shape of `/srs` (queue, FSRS, persisted chat history, end-of-session summary). Lemmas are drawn from vendored verbecc-derived conjugation data ranked by [Hermit Dave's Spanish frequency list](https://github.com/hermitdave/FrequencyWords) — the most-used verbs drill first, regardless of whether Mitch has tapped them on Kindle. The personal corpus is still used for cloze sentence sourcing (context), just not for lemma selection.

No notification, no cron, no scheduled push. `/conj` is the only entry point.

## What's already in place (verified)

- **`/srs` is the structural template.** `src/telegram/flows/srs.ts:204-313` (queue build → serve → rate → summary), `src/db/queries/vocab-reviews.ts:143-280` (queue / serve / race-safe rate), `src/fsrs/scheduler.ts` (FSRS wrapper, `nextState(card, grade)`), `src/telegram/flow-state.ts:37-49` (`SrsFlowState`). All copied operational shape — the only structural difference is callback-button (srs) → typed input (conj).
- **`ts-fsrs`** is in `package.json` from migration 053. No new runtime deps for this feature; the verbecc dataset is vendored JSON.
- **`vocab_reviews`** has 364 rows with `gloss` / `pronunciation` / `examples` populated (migrations 053-054). Lemmas live in `vocab_reviews.stem`; one row per `(LOWER(stem), lang)`.
- **Migrations are inline TypeScript** in `scripts/migrate.ts` (a `migrations` array). Highest is `054-vocab-pronunciation-examples`. Next number is **055**.
- **Router slash dispatch** lives at `src/telegram/router.ts`. `REGISTERED_SLASHES` (line 76) gates which slashes wipe other flows. End-of-flow aliases (`/done`, `/end`, `/fin`, …) peek the active flow at line 209 and call a flow-specific terminator. Active-flow continuation branches (line 322-346) take precedence over chat fallback for non-slash text. The `/srs` prose-nudge at line 323 (`Toca un botón o /done.`) sits in that block and is the one piece `/conj` deviates from — typed input is the answer, not a nudge.
- **Corpus tables for cloze sourcing.**
  - `entries.text` (Day One) — ~thousands of rows, GIN trigram index at `idx_entries_trgm`.
  - `knowledge_artifacts.body` (Obsidian + Tomos) — full markdown, GIN tsv index.
  - `vocab_reviews.examples` (jsonb) — already-enriched short sentences per lemma.
- **No existing conjugation infra** anywhere in `src/` or `scripts/` (verified via `grep -rE conjugat` — only incidental references in `books/tomos/*.md`).

## Decisions (locked)

| Question | Decision |
|---|---|
| **Cap / default** | `/conj` uses default 20; `/conj N` caps `[1,100]`. Mirrors `/srs`. |
| **Tense scope (v1)** | **Fifteen**, matching Ella minus 3 archaic forms (pretérito anterior, futuro de subjuntivo, futuro perfecto de subjuntivo). Simple indicative (5): `present_indicative`, `preterite`, `imperfect`, `future_indicative`, `conditional`. Compound indicative (4): `present_perfect`, `pluperfect`, `future_perfect`, `conditional_perfect`. Simple subjuntivo (2): `present_subjunctive`, `imperfect_subjunctive`. Compound subjuntivo (2): `present_perfect_subjunctive`, `pluperfect_subjunctive`. Imperativo (2): `imperative_affirmative`, `imperative_negative`. The Spain residency makes present perfect (`he desayunado hoy`) the default past, not preterite — narrowing to 6 would skip the most-used Spanish past. |
| **Persons** | `yo`, `tu`, `el`, `nosotros`, `vosotros`, `ellos`. Vosotros on by default (Mitch is in Spain). No config toggle in v1. Imperative cells skip the `yo` person (no `yo` imperative exists in Spanish) — enforced by `scripts/import-conjugations.ts`, not a DB CHECK (a conditional CHECK constraint would be over-engineering). |
| **Compound-tense cloze** | Single contiguous blank, two-word answer (`Yo ___ hoy` → `he comido`). Grading adds whitespace normalization (`he  comido` collapses to `he comido`) on top of the case-insensitive (but accent-sensitive) compare. The cloze masker treats `expected_form` as a literal multi-word match and replaces with one `___`. |
| **Imperfect subjuntivo `-ra` / `-se`** | Both accepted as equivalent during grading. `expected_form` in `conjugations` stores the `-ra` form (verbecc default + much more common in modern Spain); the grading function accepts the `-se` variant as exact. |
| **Pattern-batched sessions** | Strict one-pattern-per-session. When the bucket exhausts mid-session, end early rather than roll into the next pattern — avoids surprise context-switches. |
| **User-overridable pattern selection** | No. `/conj` and `/conj N` are the only forms. If today's pattern feels wrong, `/done` and run again — rotation picks differently once cards are reviewed. |
| **Conjugation dataset** | **verbecc-derived Spanish conjugation data**, sourced from [`bretttolbert/verbecc`](https://github.com/bretttolbert/verbecc). License is **LGPL-3.0**, not MIT; preserve `LICENSE-verbecc.txt` and source attribution under `data/conjugations-es/`. No runtime Python in the bot; the one-shot import reads vendored JSON generated from verbecc ahead of time. |
| **POS filter** | Lemma is drillable iff it appears in the `conjugations` table (which is verb-only by construction — verbecc only lists verbs). **No new `pos` column on `vocab_reviews`** — the lemma pool doesn't consult `vocab_reviews` at all. Pushing back on the brief's open-Q #1: adding speculative schema surface with no concrete next user is the kind of design-for-hypothetical we don't do. |
| **Cloze source pipeline (v1)** | **Lazy on-demand at serve time.** Search `vocab_reviews.examples` first, then `entries.text` + `knowledge_artifacts.body`, using an accent-aware word-boundary regex for the inflected form. Corpus hits must pass `looksSpanish(sentence)` to avoid English homograph traps (`era`, `he`, `se`, `ve`). If none hit, single Haiku call generates one short sentence and caches it on the `conjugation_reviews` row. No precomputed `cloze_candidates` table. |
| **Cold-start activation** | Lazy promotion. A `(lemma, tense, person)` cell becomes a `conjugation_reviews` row only when first selected by a session. Avoids dumping the full verbecc expansion into review state on day one. With ~12k lemmas × 15 tenses × 5-6 persons, expect hundreds of thousands to ~1M rows in `conjugations`, but only session-selected rows in `conjugation_reviews`. |
| **Diff tolerance** | **Case-insensitive only.** Accents are part of Spanish spelling — `tuvé` is wrong, not "hard." Whitespace runs collapse for compound forms (`he  comido` matches `he comido`). No Levenshtein — typos aren't recall. |
| **Grade mapping (typed → FSRS)** | exact match (case-insensitive, whitespace-normalized) → grade 3 (good); wrong → grade 1 (again); `/easy` typed in place of answer → grade 4 (easy); `/hint`-then-correct → grade 2 (hard); `/hint`-then-wrong → grade 1; `/hint`-then-`/easy` → grade 2 (you peeked, can't claim cold recall). |
| **`/hint` command** | One hint per card; reveals a non-answer-giving cue (see *Hint shapes* section). Second `/hint` replies *"Ya tienes una pista. Escribe la respuesta o /done."* Flow state tracks `hintUsed: boolean`. Any rate after `hintUsed=true` caps max grade at 2. |
| **Lemma pool** | **Frequency-ranked, not personal-corpus-derived.** Vendor [Hermit Dave's FrequencyWords](https://github.com/hermitdave/FrequencyWords) Spanish list (generated content CC-BY-SA-4.0, OpenSubtitles-derived, ~50k ranked words). Filter to verbs via intersection with `conjugations.lemma`; the rank seeds promotion order. Verbs not in the frequency list get `frequency_rank=NULL` and sort last. Cloze sentences still pull from personal corpus (entries + artifacts + examples) because that's about context, not selection. |
| **Reflexive verbs** | Cloze covers exactly the inflected verb word; pronoun stays in the frame. *"Mi padre se ___ a las seis."* expects `levantaba`. Matches the non-reflexive case and Anki/Ella conventions. |
| **`/conj` while another flow is active** | Soft-block, same as `/srs`: `Termina /done primero — tienes flow X activa.` |
| **`/done` mid-card after serve, before rate** | Discard. No log row. `current_session_rated_at` stays NULL, card is eligible again on next `/conj`. Same as `/srs`. |
| **Race / stale sessions** | Per-card `current_session_id UUID` + `current_session_rated_at TIMESTAMPTZ`. Rate updates only if session_id matches and rated_at is NULL. In-process stale state fails loudly; full bot restart loses the in-memory flow and must not rate anything accidentally. Mirror the DB guard shape of `vocab_reviews`, while acknowledging typed flows cannot recover from process-local state loss without a future persistent-flow table. |
| **Pattern selection ranking** | Existing reviews: (1) most-due-cells wins; (2) tie-break by avg lapses descending (highest miss-rate first); (3) tie-break by least-recently-drilled pattern; (4) alphabetical final tie-break for determinism. Cold start: do **not** sort by largest bucket; use `CONJ_PATTERN_BOOTSTRAP_ORDER` below so common high-value patterns seed before huge regular buckets dominate. |
| **`/easy` escape hatch** | Keep. Typed in place of the answer, grades current card 4 and advances. Mirrors Ella's no-penalty + escape-hatch ergonomics. |

## Architecture

```
Telegram /conj N ─────► router (NEW: REGISTERED_SLASHES += "conj")
                          │
                          ├─ getFlow(chatId) truthy? → soft-block
                          ├─ pickPatternForSession  → most-due / cold-start fallback
                          ├─ buildAndPromoteQueue   → up to N cells in pattern, ordered by frequency_rank
                          └─ startConjFlow → announce pattern → serve first card

Telegram free text ───► router → active flow "conj"? → continueConjFlow
                                                          │
                                                          ├─ "/easy" → grade 4 (or 2 if hintUsed) + advance
                                                          ├─ "/hint" → smartHint(pattern, …) → reveal + wait
                                                          └─ grade(typed, expected) → 1|3 (capped at 2 if hintUsed) + advance

Telegram /done ───────► router END_FLOW_ALIASES (existing) → endConjFlow → summary + clearFlow

Card serve:    findClozeSentence(lemma, expected_form, tense)
                  │
                  ├─ corpus hit  → rotate by reps, render with `___`
                  └─ no hit       → cached generated_sentence
                                       │
                                       └─ null → Haiku one-shot → cache → render

import-conjugations (one-shot)
   verbecc JSON + verb-frequency-es.txt ─► parse + rank ─► classifyPattern() ─► INSERT conjugations
```

## Schema (migration 055)

Appended to `scripts/migrate.ts` as `{ name: '055-conjugations', sql: ... }` and mirrored into `specs/schema.sql`.

```sql
-- Vendored conjugation table. Spanish verb cells across the 15 v1 tenses;
-- populated once
-- by scripts/import-conjugations.ts from data/conjugations-es/*.json. Read-only
-- at runtime — never written by the flow.
CREATE TABLE IF NOT EXISTS conjugations (
    id              BIGSERIAL PRIMARY KEY,
    lemma           TEXT NOT NULL,
    tense           TEXT NOT NULL,
    person          TEXT NOT NULL,
    form            TEXT NOT NULL,
    pattern         TEXT NOT NULL,
    -- Source conjugation template id/name when the vendored data exposes one.
    -- Runtime code does not depend on it; it is for import debugging.
    source_template TEXT,
    -- Frequency rank from data/verb-frequency-es.txt (Hermit Dave). NULL when
    -- the lemma doesn't appear in the top ~50k Spanish words. Lower = more common.
    -- Denormalized onto every (lemma,tense,person) row for query simplicity.
    frequency_rank  INT,
    CONSTRAINT conjugations_tense_check  CHECK (tense IN (
        'present_indicative','preterite','imperfect','future_indicative','conditional',
        'present_perfect','pluperfect','future_perfect','conditional_perfect',
        'present_subjunctive','imperfect_subjunctive',
        'present_perfect_subjunctive','pluperfect_subjunctive',
        'imperative_affirmative','imperative_negative')),
    CONSTRAINT conjugations_person_check CHECK (person IN (
        'yo','tu','el','nosotros','vosotros','ellos'))
);
CREATE UNIQUE INDEX IF NOT EXISTS conjugations_cell_idx
    ON conjugations (lemma, tense, person);
CREATE INDEX IF NOT EXISTS conjugations_pattern_idx       ON conjugations (pattern);
CREATE INDEX IF NOT EXISTS conjugations_lemma_idx         ON conjugations (lemma);
-- Promotion ordering: lowest frequency_rank first; NULLs (rare verbs) sort last.
CREATE INDEX IF NOT EXISTS conjugations_pattern_freq_idx
    ON conjugations (pattern, frequency_rank NULLS LAST);

-- Per-cell FSRS state. Mirrors vocab_reviews. Rows are inserted lazily on first
-- session that selects the cell (see lazy-promotion algorithm below).
CREATE TABLE IF NOT EXISTS conjugation_reviews (
    id              BIGSERIAL PRIMARY KEY,
    lemma           TEXT NOT NULL,
    tense           TEXT NOT NULL,
    person          TEXT NOT NULL,
    expected_form   TEXT NOT NULL,
    pattern         TEXT NOT NULL,
    -- Cached LLM-generated sentence (only set when no corpus hit at serve time).
    -- `generated_form` is the inflected form that appears in the cached sentence
    -- (≈ expected_form, but kept separately in case generator picks a variant).
    generated_sentence TEXT,
    generated_form     TEXT,
    -- FSRS Card fields, persisted verbatim:
    due             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stability       DOUBLE PRECISION NOT NULL DEFAULT 0,
    difficulty      DOUBLE PRECISION NOT NULL DEFAULT 0,
    elapsed_days    DOUBLE PRECISION NOT NULL DEFAULT 0,
    scheduled_days  DOUBLE PRECISION NOT NULL DEFAULT 0,
    reps            INT NOT NULL DEFAULT 0,
    lapses          INT NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'new',
    last_review     TIMESTAMPTZ,
    -- session-race guard:
    current_session_id        UUID,
    current_session_served_at TIMESTAMPTZ,
    current_session_rated_at  TIMESTAMPTZ,
    chat_id         TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT conj_reviews_tense_check  CHECK (tense IN (
        'present_indicative','preterite','imperfect','future_indicative','conditional',
        'present_perfect','pluperfect','future_perfect','conditional_perfect',
        'present_subjunctive','imperfect_subjunctive',
        'present_perfect_subjunctive','pluperfect_subjunctive',
        'imperative_affirmative','imperative_negative')),
    CONSTRAINT conj_reviews_person_check CHECK (person IN (
        'yo','tu','el','nosotros','vosotros','ellos')),
    CONSTRAINT conj_reviews_state_check  CHECK (state IN ('new','learning','review','relearning')),
    CONSTRAINT conj_reviews_status_check CHECK (status IN ('active','suspended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS conjugation_reviews_cell_idx
    ON conjugation_reviews (lemma, tense, person);
CREATE INDEX IF NOT EXISTS conjugation_reviews_pattern_due_idx
    ON conjugation_reviews (pattern, due);
CREATE INDEX IF NOT EXISTS conjugation_reviews_state_due_idx
    ON conjugation_reviews (state, due);
CREATE INDEX IF NOT EXISTS conjugation_reviews_status_due_idx
    ON conjugation_reviews (status, due);

CREATE TABLE IF NOT EXISTS conjugation_review_log (
    id                BIGSERIAL PRIMARY KEY,
    review_id         BIGINT NOT NULL REFERENCES conjugation_reviews(id) ON DELETE CASCADE,
    rating            SMALLINT NOT NULL,
    grade_kind        TEXT NOT NULL,                  -- 'exact' | 'wrong' | 'easy' | 'hint_correct' | 'hint_wrong' | 'hint_easy'
    typed_answer      TEXT,                           -- raw user input, NULL on 'easy' / 'hint_easy'
    hint_used         BOOLEAN NOT NULL DEFAULT false,
    cloze_source      TEXT NOT NULL,                  -- 'corpus' | 'generated'
    state_before      TEXT NOT NULL,
    state_after       TEXT NOT NULL,
    stability_before  DOUBLE PRECISION,
    stability_after   DOUBLE PRECISION,
    difficulty_before DOUBLE PRECISION,
    difficulty_after  DOUBLE PRECISION,
    elapsed_days      DOUBLE PRECISION,
    scheduled_days    DOUBLE PRECISION,
    session_id        UUID NOT NULL,
    chat_id           TEXT,
    reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT conj_review_log_rating_check     CHECK (rating IN (1,2,3,4)),
    CONSTRAINT conj_review_log_grade_kind_check CHECK (grade_kind IN
        ('exact','wrong','easy','hint_correct','hint_wrong','hint_easy')),
    CONSTRAINT conj_review_log_source_check     CHECK (cloze_source IN ('corpus','generated'))
);
CREATE INDEX IF NOT EXISTS conjugation_review_log_review_idx
    ON conjugation_review_log (review_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS conjugation_review_log_session_idx
    ON conjugation_review_log (session_id);
CREATE INDEX IF NOT EXISTS conjugation_review_log_reviewed_at_idx
    ON conjugation_review_log (reviewed_at DESC);
```

`grade_kind`, `typed_answer`, and `hint_used` are added beyond the `vocab_review_log` shape because conjugation grading has a richer signal than 1-4 alone. Later analysis ("Mitch always misses person `vosotros`", "hint-then-correct rate is climbing in pattern X — ready to promote bucket") needs the typed answer and hint flag.

## Pattern taxonomy (locked)

Each `(lemma, tense, person)` cell maps to **exactly one** pattern. Most tenses share one pattern across all persons, but present indicative, preterite stem-changing verbs, present subjunctive, and imperative cells can differ by person. Do not collapse these to `(lemma, tense)`; that would mislabel cells like `tener · present_indicative · yo` (`tengo`, yo-go) versus `tener · present_indicative · tú` (`tienes`, e→ie).

Mapping is deterministic from verbecc's source template/form plus a small rule layer for the irregularity dimensions verbecc doesn't separately tag (irregular past participle, irregular `tú` imperative, person-scoped stem changes). 33 buckets total.

```
# Present indicative (9)
present_regular_ar
present_regular_er
present_regular_ir
present_stem_eie              (pensar, entender, cerrar, comenzar)
present_stem_oue              (poder, encontrar, recordar)
present_stem_ei               (pedir, servir, repetir)
present_yo_go                 (tener, poner, salir, hacer — for 1ps stem)
present_yo_zco                (conocer, parecer, agradecer)
present_irregular             (ser, estar, ir, haber, dar, saber, ver — small enough to lump)

# Preterite (4)
preterite_regular_ar
preterite_regular_er_ir       (-er and -ir share endings in this tense)
preterite_strong              (tuve, dije, supe, hice, puse, vine, traje, …)
preterite_stem_iu             (pedir → pidió, dormir → durmió, sentir → sintió)

# Imperfect (2)
imperfect_regular
imperfect_irregular           (ser, ir, ver — exactly three)

# Future indicative (2)
future_regular
future_irregular_stem         (tendré, sabré, pondré, vendré, podré, querré, haré, diré, …)

# Conditional (2)
conditional_regular
conditional_irregular_stem    (tendría, sabría, pondría, … — same stems as future)

# Compound indicative (4) — one per tense; drills haber paradigm + participle together,
# regular and irregular participles interleaved
present_perfect               (he hablado / he dicho)
pluperfect                    (había hablado / había dicho)
future_perfect                (habré hablado / habré dicho)
conditional_perfect           (habría hablado / habría dicho)

# Present subjunctive (3)
present_subj_regular
present_subj_yo_irreg_derived (subj built from yo-irregular stem: tenga, conozca, salga, ponga, …)
present_subj_irregular        (sea, vaya, dé, vea, sepa, esté, haya — small set)

# Imperfect subjunctive (2)
imperfect_subj_regular
imperfect_subj_strong_stem    (built from preterite-strong stem: tuviera, dijera, supiera, …)

# Compound subjunctive (2) — same lumping as compound indicative
present_perfect_subj          (haya hablado / haya dicho)
pluperfect_subj               (hubiera hablado / hubiera dicho)

# Imperative (3)
imperative_affirmative_regular
imperative_affirmative_tu_irreg  (the 8: di [decir], haz [hacer], ve [ir], pon [poner],
                                  sal [salir], sé [ser], ten [tener], ven [venir])
imperative_negative              (negatives derive from present subjunctive; one bucket —
                                  irregularity inherits from the subjuntivo cells)
```

A `lemma` like `tener` thus generates cells across multiple patterns:
- `tener · present_indicative · yo` → `present_yo_go`
- `tener · present_indicative · tú/él/ellos` → `present_stem_eie`
- `tener · present_indicative · nosotros/vosotros` → `present_regular_er`
- `tener · preterite · *` → `preterite_strong`
- `tener · imperfect · *` → `imperfect_regular`
- `tener · future_indicative · *` → `future_irregular_stem`
- `tener · conditional · *` → `conditional_irregular_stem`
- `tener · present_perfect · *` → `present_perfect`
- `tener · pluperfect · *` → `pluperfect`
- `tener · present_subjunctive · *` → `present_subj_yo_irreg_derived`
- `tener · imperfect_subjunctive · *` → `imperfect_subj_strong_stem`
- `tener · present_perfect_subjunctive · *` → `present_perfect_subj`
- `tener · imperative_affirmative · tu` → `imperative_affirmative_tu_irreg` (form: `ten`)

A regular verb like `hablar` lands in `present_regular_ar`, `preterite_regular_ar`, `imperfect_regular`, `future_regular`, `conditional_regular`, all 4 compound indicatives, `present_subj_regular`, `imperfect_subj_regular`, both compound subjunctives, `imperative_affirmative_regular`, `imperative_negative` — 13 distinct pattern groups × 5-6 persons.

The classifier lives in `scripts/lib/pattern-classifier.ts` and is unit-tested with representative cells per bucket. Verbecc's template/form data disambiguates most cases; the small rule layer handles (a) compound-tense classification (trivially: the tense determines the bucket, lumping participle regularity), (b) person-scoped stem changes (`pedir · preterite · él` is `preterite_stem_iu`, while `pedir · preterite · yo` remains regular `-er/-ir`), (c) the 8-verb `imperative_affirmative_tu_irreg` set (hardcoded list), and (d) the small `present_irregular` / `present_subj_irregular` sets (also hardcoded).

## File-by-file changes

### New files

| File | Purpose |
|---|---|
| `data/conjugations-es/` | Vendored verbecc-derived JSON data. Preserve LGPL-3.0 license and source attribution in `LICENSE-verbecc.txt` / `SOURCE.md`. The JSON must include enough source metadata for import debugging: lemma, raw form, raw person/pronoun, tense/mood, and verbecc template id/name when available. |
| `data/verb-frequency-es.txt` | Vendored [Hermit Dave FrequencyWords](https://github.com/hermitdave/FrequencyWords) Spanish list (OpenSubtitles 2018). The repository code is MIT, but generated content is **CC-BY-SA-4.0**; preserve attribution/license in `LICENSE-frequency-words.txt`. One `word count` per line, frequency-sorted. |
| `scripts/import-conjugations.ts` | One-shot import: parse verbecc JSON → normalize raw forms/persons → classify pattern → join Hermit Dave list to compute `frequency_rank` per lemma (lemma's position in the file = rank; missing = NULL) → `INSERT conjugations`. Idempotent (`ON CONFLICT (lemma,tense,person) DO UPDATE SET frequency_rank=EXCLUDED.frequency_rank, ...`). Run as `pnpm import:conjugations`. |
| `scripts/lib/pattern-classifier.ts` | Pure: `classifyPattern({ lemma, tense, person, form, template }): PatternName`. Verbecc template/form data is the primary signal; small rule layer for the few person-scoped cases verbecc lumps differently than our buckets. Unit-tested in isolation. |
| `src/telegram/conj-hints.ts` | Pure: `buildHint({ pattern, tense, person, expected_form }): string`. ~33 hint templates keyed by pattern. Returns 1-line non-revealing cue. Unit-tested per pattern. |
| `src/db/queries/conjugations.ts` | Read-only queries against `conjugations`: `getConjugation(lemma, tense, person)`, `getCellsForLemma`, `getCellsByPattern`, `countCellsPerPattern`. |
| `src/db/queries/conjugation-reviews.ts` | Mirrors `vocab-reviews.ts`. `pickPatternForSession`, `buildConjugationQueue` (with lazy promotion), `serveConjugationCard`, `rateConjugationCard` (race-safe with transactional log insert), `getConjugationReviewById`, `getConjugationSessionCounts`, `getPatternBucketCounts`. Parameterized SQL only. |
| `src/db/queries/cloze-source.ts` | `findClozeSentence({ lemma, lang, form, tense, reps })` → `{ sentence, source: 'entries' \| 'artifacts' \| 'examples', cursor: string }` or `null`. Word-boundary regex (`~*`) over `vocab_reviews.examples[*].es` first, then `entries.text` and `knowledge_artifacts.body`. The `tense` arg switches on the `imperative_negative` regex variant (anchors on `no\s+<form>`). App code extracts the containing sentence, caps at 140 chars, dedupes, filters with `looksSpanish(sentence)`, then rotates by `reps % candidates.length`. |
| `src/llm/cloze-gen.ts` | `generateClozeSentence({ lemma, tense, person, form })` → `{ sentence, form }`. Single Haiku call, ≤80 chars target, prompt locks the form into the sentence so we don't have to re-detect. ~$0.0001/call, fired only on corpus miss. |
| `src/fsrs/conj-grading.ts` | Pure: `gradeAnswer(typed, expected, tense?): { kind: 'exact'\|'wrong'\|'easy', grade: 1\|3\|4 }`. Case-insensitive + whitespace-normalized; accent-sensitive. `/easy` token is parsed here. The hint-cap transformation (`exact → hint_correct/2`, etc.) lives in `continueConjFlow`, not here. |
| `src/telegram/flows/conj.ts` | `startConjFlow`, `continueConjFlow` (handles typed answer, `/easy`), `endConjFlow`, internal `serveNextCard` / `endSessionWithSummary`. Pure-helper extractions for `renderCardFront`, `renderRatedSummary`, `parseConjArgs` so the branchy logic is unit-testable without a Telegram mock. |
| `src/db/queries/index.ts` | Re-export the three new query modules. |

### Edited files

| File | Change |
|---|---|
| `scripts/migrate.ts` | Append migration `055-conjugations` with the full DDL above. |
| `specs/schema.sql` | Mirror migration 055 (canonical schema per CLAUDE.md). |
| `src/telegram/flow-state.ts` | Add `ConjFlowState` and include in `FlowName` + `FlowState` union. Shape: `{ flow: "conj"; sessionId: string; startedAt: number; pattern: string; queue: string[]; queueIndex: number; reviewedCount: number; countsByGradeKind: { exact: number; wrong: number; easy: number; hint_correct: number; hint_wrong: number; hint_easy: number }; hintCount: number; currentCardId: string \| null; currentExpected: string \| null; currentTense: string \| null; currentPattern: string \| null; currentPerson: string \| null; currentLemma: string \| null; currentSentence: string \| null; currentClozeSource: 'corpus' \| 'generated' \| null; hintUsed: boolean; }`. The current* fields beyond cardId+expected+tense are needed by `buildHint`. |
| `src/telegram/router.ts` | (1) `REGISTERED_SLASHES += "conj"` only. Do **not** register `hint`; `/hint` is valid only inside an active conj flow and must fall through to `continueConjFlow`. (2) Slash dispatch: `if (command.name === "conj") { startConjFlow(...); return; }` — startConjFlow handles soft-block (place BEFORE the line-249 clearFlow branch, mirror of how `/srs` is positioned). (3) END_FLOW_ALIASES peek-branch: `if (peek?.flow === "conj") { endConjFlow(...); return; }` next to the existing srs/practice cases. (4) Active-flow continuation: add `if (active?.flow === "conj") { continueConjFlow(...); return; }` before the `active?.flow === "srs"` prose-nudge so typed answers and `/hint` are consumed by conj. |
| `package.json` | Add scripts: `"import:conjugations": "tsx scripts/import-conjugations.ts"`. No new runtime deps. |
| `CLAUDE.md` / `AGENTS.md` | (a) Add `/conj` (and `/hint` as a sub-command of the conj flow) to the Telegram command surface description. (b) Update "Directory Map" to list `src/telegram/flows/conj.ts`, `src/telegram/conj-hints.ts`, `src/db/queries/conjugations.ts`, `src/db/queries/conjugation-reviews.ts`, `src/db/queries/cloze-source.ts`, `src/llm/cloze-gen.ts`, `src/fsrs/conj-grading.ts`, `scripts/import-conjugations.ts`, `scripts/lib/pattern-classifier.ts`, `data/conjugations-es/`, `data/verb-frequency-es.txt`. (c) Add a Gotcha: `conjugations` is read-only post-import; rebuild via `pnpm import:conjugations` (idempotent). To refresh the frequency-rank ordering after updating `verb-frequency-es.txt`, re-run the same script. |

## Import normalization contract

The import script is responsible for converting raw verbecc output into the repo's drill-cell shape. Do this before `classifyPattern` and before inserting into `conjugations`.

- **Pronoun/person selection:** keep exactly these Spain Spanish persons: `yo`, `tu`, `el`, `nosotros`, `vosotros`, `ellos`. Map raw `él/ella/usted` to `el`; map raw `ellos/ellas/ustedes` to `ellos`; drop `vos` and any duplicate regional/voseo rows.
- **Bare form extraction:** raw outputs may include subject pronouns (`yo soy`, `tú eres`). Strip the leading subject pronoun and store only the answer form (`soy`, `eres`). The renderer supplies the person cue separately.
- **Reflexives:** keep reflexive lemmas as their own lemma (`levantarse`), but strip reflexive clitics from `form` (`me levanto` → `levanto`). Cloze frames keep the pronoun outside the blank: `Me ___ temprano.` expects `levanto`.
- **Imperatives:** skip `yo` for both imperative tenses. Store negative imperative as the bare present-subjunctive form (`hables`), never `no hables`; the cloze renderer places `no` outside the blank.
- **Compound tenses:** store the full auxiliary + participle as `form` (`he comido`, `habría dicho`), with a single ASCII space between tokens.
- **Whitespace/case:** trim, collapse whitespace, lowercase only for lookup keys and frequency matching. Preserve accents and display casing in stored `form` (expected data should already be lowercase Spanish).
- **Deduplication:** after normalization, `(lemma, tense, person)` must be unique. If raw data yields duplicates, prefer the non-voseo Spain form and fail the import if ambiguity remains.

## Critical SQL

**Pattern selection for today** — most-due-cells wins, tie-broken by miss rate and least-recently-drilled:

```sql
WITH per_pattern AS (
  SELECT pattern,
         COUNT(*) FILTER (WHERE due <= NOW() AND state <> 'new') AS due_count,
         COUNT(*) FILTER (WHERE state = 'new')                    AS new_count,
         AVG(lapses)                                                AS miss,
         MAX(last_review)                                          AS most_recent
    FROM conjugation_reviews
   WHERE status='active'
   GROUP BY pattern
)
SELECT pattern FROM per_pattern
 WHERE due_count + new_count > 0
 ORDER BY due_count DESC, miss DESC NULLS LAST, most_recent ASC NULLS FIRST, pattern ASC
 LIMIT 1;
```

If the result is empty (cold start, or existing cards are not due and no `new` rows remain in any pattern), fall back to a fixed bootstrap order over unpromoted cells. This prevents huge regular buckets from winning just because they have the most cells.

```sql
WITH pattern_priority(pattern, priority) AS (
  VALUES
    ('present_irregular', 1),
    ('present_yo_go', 2),
    ('present_stem_eie', 3),
    ('present_stem_oue', 4),
    ('present_stem_ei', 5),
    ('present_regular_ar', 6),
    ('present_regular_er', 7),
    ('present_regular_ir', 8),
    ('present_yo_zco', 9),
    ('present_perfect', 10),
    ('preterite_strong', 11),
    ('preterite_regular_ar', 12),
    ('preterite_regular_er_ir', 13),
    ('preterite_stem_iu', 14),
    ('imperfect_irregular', 15),
    ('imperfect_regular', 16),
    ('present_subj_irregular', 17),
    ('present_subj_yo_irreg_derived', 18),
    ('present_subj_regular', 19),
    ('imperative_affirmative_tu_irreg', 20),
    ('imperative_affirmative_regular', 21),
    ('imperative_negative', 22),
    ('future_irregular_stem', 23),
    ('future_regular', 24),
    ('conditional_irregular_stem', 25),
    ('conditional_regular', 26),
    ('pluperfect', 27),
    ('present_perfect_subj', 28),
    ('imperfect_subj_strong_stem', 29),
    ('imperfect_subj_regular', 30),
    ('conditional_perfect', 31),
    ('future_perfect', 32),
    ('pluperfect_subj', 33)
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
 LIMIT 1;
```

**Queue build with lazy promotion** — N cells from the chosen pattern, due first, then new, then newly-promoted:

```sql
-- (1) Existing due cells in this pattern, oldest first.
SELECT id FROM conjugation_reviews
 WHERE status='active' AND pattern=$1 AND state <> 'new' AND due <= NOW()
 ORDER BY due ASC
 LIMIT $2;

-- (2) Existing new-state cells in this pattern, FIFO.
SELECT id FROM conjugation_reviews
 WHERE status='active' AND pattern=$1 AND state='new'
 ORDER BY id ASC
 LIMIT $2;

-- (3) Promote unpromoted candidates in this pattern up to remaining cap.
INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern)
SELECT c.lemma, c.tense, c.person, c.form, c.pattern
  FROM conjugations c
  LEFT JOIN conjugation_reviews cr
    ON cr.lemma=c.lemma AND cr.tense=c.tense AND cr.person=c.person
 WHERE c.pattern=$1 AND cr.id IS NULL
 ORDER BY c.frequency_rank NULLS LAST, c.lemma, c.tense, c.person
 LIMIT $2
ON CONFLICT (lemma, tense, person) DO NOTHING
RETURNING id;
```

Ordering by `c.frequency_rank NULLS LAST` promotes the most-common verbs first; rare verbs (`frequency_rank IS NULL`) come last. Combined queue is capped at the total N; if (1) yields N, (2) and (3) don't run.

**Race-safe rate** — exactly mirrors `vocab_reviews.rateCard`, with the extra log fields:

```sql
UPDATE conjugation_reviews
   SET stability=$1, difficulty=$2, elapsed_days=$3, scheduled_days=$4,
       reps=reps+1, lapses=$5, state=$6, due=$7, last_review=NOW(),
       current_session_rated_at=NOW(), updated_at=NOW()
 WHERE id=$8 AND current_session_id=$9 AND current_session_rated_at IS NULL
RETURNING id;
```

`rowCount=0` → stale in-process session or already-rated → no log row inserted, flow no-ops gracefully.

**Cloze source lookup** — word-boundary regex; case-insensitive; accent-aware (the form already carries the right accents from `conjugations.form`). `vocab_reviews.examples` are trusted Spanish examples and sort first; broad corpus hits must pass a lightweight Spanish-context filter before use.

Per-tense regex variants:
- Default (single-word forms — every simple-indicative, simple-subjunctive, imperative-affirmative, simple-imperative tense, plus the compound tenses where `form` is a multi-word literal like `he comido`): `(^|[^a-záéíóúüñ])<form>([^a-záéíóúüñ]|$)`. The regex literal contains the space for compound forms; PG's regex matches it verbatim.
- `imperative_negative` (stored as bare subjuntivo form, e.g. `hables`): anchor on the leading `no`: `(^|[^a-záéíóúüñ])no\s+<form>([^a-záéíóúüñ]|$)`. Without this anchor we'd surface present-subjunctive uses ("Quiero que hables") and mis-frame them as negative commands. Sentence extraction then strips the leading `no ` so the masker can re-add it via the frame `no ___`.

```sql
-- Union across the three corpus tables. Each branch returns a candidate
-- body/sentence + a stable cursor. App code extracts the sentence, filters,
-- dedupes, then rotates by reps.
WITH form_pat AS (SELECT '(^|[^a-záéíóúüñ])' || lower($1) || '([^a-záéíóúüñ]|$)' AS p)
SELECT 'examples' AS source, ex->>'es' AS sentence, vr.id::text AS cursor
  FROM vocab_reviews vr,
       jsonb_array_elements(vr.examples) ex,
       form_pat
 WHERE LOWER(vr.stem) = $2 AND vr.lang='es'
   AND lower(ex->>'es') ~ form_pat.p
UNION ALL
SELECT 'entries', e.text, e.uuid
  FROM entries e, form_pat
 WHERE e.text ~* form_pat.p
   AND char_length(e.text) <= 6000  -- skip absurdly long entries; sentence-extract in app code
UNION ALL
SELECT 'artifacts', ka.body, ka.id::text
  FROM knowledge_artifacts ka, form_pat
 WHERE ka.body ~* form_pat.p
   AND ka.deleted_at IS NULL
LIMIT 50;
```

App-side:
- Split each non-example hit on `.!?¡¿…` and pick the segment that contains the form; examples are already sentence-shaped.
- Truncate at 140 chars, deduplicate by normalized sentence text.
- Reject corpus candidates unless `looksSpanish(sentence)` returns true. Implementation: count Spanish function-token hits from a fixed set (`el/la/los/las/un/una/que/de/en/por/para/con/no/se/me/te/lo/le/y/pero/cuando/porque/como/si`) plus accented Spanish characters; require at least 2 signals for entries/artifacts. Examples skip this filter because they were generated as Spanish examples.
- Rotate by `reps % candidates.length`.
- Tests must include English false positives: `"the modern era"` must not satisfy `form='era'`; `"he went home"` must not satisfy `form='he comido'` or bare `form='he'` if a future helper ever searches auxiliaries.

**Session counts** (end-of-session summary):

```sql
SELECT COUNT(*) FROM conjugation_reviews
 WHERE status='active' AND state<>'new' AND due <= NOW();                           -- M: due (all patterns)
SELECT COUNT(*) FROM conjugation_reviews
 WHERE status='active'
   AND (state IN ('learning','relearning')
        OR (lapses >= 2 AND last_review > NOW() - INTERVAL '30 days'));             -- K: stalling (all patterns)
SELECT COUNT(*) FROM conjugations c
  LEFT JOIN conjugation_reviews cr
    ON cr.lemma=c.lemma AND cr.tense=c.tense AND cr.person=c.person
 WHERE cr.id IS NULL AND c.frequency_rank IS NOT NULL;                              -- J: unpromoted cells in the frequency list
```

## Telegram UX

**Soft-block on existing flow** (mirrors `/srs`):
```
Termina /done primero — tienes flow practice activa.
```

**Empty queue** (no candidate cells — only happens if the frequency list import didn't run):
```
Cola vacía. Corre `pnpm import:conjugations` y reintenta.
```

**Pattern announce + first card** (single message at start):
```
🇪🇸 Hoy: pretérito · cambio fuerte. 12 cartas.

Cuando ___ joven, vivía en Madrid.
<i>ser · 1ps · pretérito</i>

Escribe la respuesta · /hint · /easy · /done
```

The hint line uses Spanish tense names and person tags `1ps / 2ps / 3ps / 1pp / 2pp / 3pp`. Tense-name map (locked in the spec, used by `renderCardFront`):

| Internal | Spanish hint |
|---|---|
| `present_indicative` | `presente` |
| `preterite` | `pretérito` |
| `imperfect` | `imperfecto` |
| `future_indicative` | `futuro` |
| `conditional` | `condicional` |
| `present_perfect` | `pretérito perfecto` |
| `pluperfect` | `pluscuamperfecto` |
| `future_perfect` | `futuro perfecto` |
| `conditional_perfect` | `condicional perfecto` |
| `present_subjunctive` | `presente de subjuntivo` |
| `imperfect_subjunctive` | `imperfecto de subjuntivo` |
| `present_perfect_subjunctive` | `pretérito perfecto de subjuntivo` |
| `pluperfect_subjunctive` | `pluscuamperfecto de subjuntivo` |
| `imperative_affirmative` | `imperativo afirmativo` |
| `imperative_negative` | `imperativo negativo` |

Person for imperative cells omits `1ps` (no yo imperative). Imperative-negative cards show the leading `no` outside the blank: `Por favor, no ___ tan rápido. (hablar · 2ps · imperativo negativo)` → user types `hables`.

**After correct exact**:
```
✓ era (good) → next in 4d
```
…then serve next card (as a new message).

**After wrong** (accent miss `tuvé` is wrong; so is any other miss):
```
✗ Expected: <b>tuve</b>
Cuando <b>tuve</b> el perro, era niño.
(again → next in 1m)
```

**After `/easy`**:
```
⏭ era (easy → next in 7d)
```

**After `/hint`** (card stays open, waits for next answer):
```
💡 Pista — stem: tuv-
```
After the hint is shown, the next typed answer grades capped at hard (2):
```
✓ tuve (hint → hard) → next in 1d        # hint then correct
✗ Expected: tuve  (hint → again → 1m)    # hint then wrong
⏭ tuve (hint+easy → hard)                # hint then /easy
```

**Second `/hint` on the same card**:
```
Ya tienes una pista. Escribe la respuesta o /done.
```

**Natural end** (queue drained):
```
Listo. Patrón: pretérito · cambio fuerte.
12 revisadas — 8 ✓ · 1 ⏭ · 3 ✗ · 4 con pista.
M pendientes (otros patrones), K atascadas, J celdas sin promover.
```
Counts are grouped: `exact + hint_correct → ✓`, `easy + hint_easy → ⏭`, `wrong + hint_wrong → ✗`, and "con pista" totals `hint_* `.

**`/done` early exit** — same shape prefixed `Stopped. `. The card-in-flight (served-but-not-rated) discards cleanly: `current_session_rated_at` stays NULL, so next `/conj` re-derives the queue and the same cell appears again.

**Unknown typed token mid-flow**: non-slash garbage (e.g. an emoji) is treated as a wrong answer because any non-command text is an attempt to conjugate. Unknown slash commands are not graded; they get `Escribe la respuesta, /hint, /easy o /done.` and the card stays open.

## Flow lifecycle (file structure mirrors `src/telegram/flows/srs.ts`)

### `parseConjArgs(argText)` — pure
Mirrors `parseSrsArgs`. Returns `{ newCap: undefined }` (default), `{ newCap: number }`, or `{ error: string }`.

### `startConjFlow(deps & { argText })`
1. Persist `/conj…` user message exactly once before any reply.
2. `getFlow(chatId)` → soft-block if truthy; reply and `logUsage({ action: "conj.start", args: { reason: "soft_block", activeFlow }, ok: true })`.
3. Parse arg → cap.
4. `pickPatternForSession()` → pattern name or `null`. If `null`, empty-queue reply + `logUsage({ action: "conj.start", args: { reason: "no_candidates", cap }, ok: true })` + bail.
5. `buildConjugationQueue(pattern, cap)` → array of `conjugation_reviews.id`. Returns `[]` only in pathological cases (race after the cold-start check).
6. Build `ConjFlowState`, `setFlow`.
7. `logUsage({ action: "conj.start", args: { pattern, cap, queueSize } })`.
8. `serveNextCard()` — sends pattern-announce + first card in one message.

### `serveNextCard()`
1. If `queueIndex >= queue.length`, `endSessionWithSummary("Listo")`.
2. Fetch the review row (`getConjugationReviewById`). If missing (deleted mid-flight), skip index, recurse.
3. `serveConjugationCard()` — `UPDATE conjugation_reviews SET current_session_id, current_session_served_at = NOW(), current_session_rated_at = NULL, chat_id WHERE id = $`.
4. Resolve the cloze sentence:
   - Try `findClozeSentence({ lemma, lang: 'es', form: expected_form, tense: row.tense })` — the `tense` arg switches on the `imperative_negative` regex variant (anchor on `no\s+<form>`).
   - If hit, pick by `reps % candidates.length`. `clozeSource = 'corpus'`.
   - Else if `row.generated_sentence` is set, use it. `clozeSource = 'generated'`.
   - Else call `generateClozeSentence()`, `UPDATE conjugation_reviews SET generated_sentence, generated_form WHERE id`, use it. `clozeSource = 'generated'`.
5. Mask the form in the sentence (case-insensitive word-boundary replace, preserve surrounding punctuation, replace match with `___`). For `imperative_negative`, the masker strips the leading `no ` from the matched span and the renderer re-adds it as a literal in the frame (`no ___`).
6. Update flow state: `currentCardId`, `currentExpected = row.expected_form`, `currentTense = row.tense`, `currentPattern = row.pattern`, `currentPerson = row.person`, `currentLemma = row.lemma`, `currentSentence = sentence`, `currentClozeSource = clozeSource`. Reset `hintUsed = false` for the new card.
7. Send card render. Persist assistant message.
8. `logUsage({ action: "conj.serve", args: { lemma, tense, person, pattern, frequencyRank, clozeSource } })`.

### `continueConjFlow({ text })`
1. Persist user message.
2. If no `currentCardId` in an otherwise-active conj flow state (internal stale state), reply `Card desincronizada. /done y vuelve a empezar.` and `clearFlow` — fail loudly rather than silently mis-grade. A full bot restart loses in-memory flow state entirely, so a later typed answer routes like any other non-flow chat message; no DB write should occur.
3. **`/hint` handling**: if `text.trim() === "/hint"`:
   - If `state.hintUsed === true` → reply *"Ya tienes una pista. Escribe la respuesta o /done."* and bail (no rate, no advance).
   - Otherwise: `hintText = buildHint({ pattern: state.currentPattern, tense: state.currentTense, person: state.currentPerson, expected_form: state.currentExpected })`; set `state.hintUsed = true`; `state.hintCount += 1`; `setFlow`; send `💡 Pista — ${hintText}`; persist assistant message; `logUsage({ action: "conj.hint", args: { reviewId, lemma, tense, person, pattern } })`; **do not advance** — wait for next typed answer.
4. Unknown slash handling: if `text.trim().startsWith("/")` and is not `/hint`, `/easy`, or an end-flow alias already intercepted by the router, reply `Escribe la respuesta, /hint, /easy o /done.` and do not grade. Non-slash text, including emoji or garbage, is treated as an answer attempt.
5. `grade = gradeAnswer(text, state.currentExpected, state.currentTense)`:
   - `text.trim() === "/easy"` → `{ kind: 'easy', grade: 4 }`.
   - Otherwise normalize both (lowercase + collapse whitespace; **no accent stripping**); if equal → `exact / 3`; else → `wrong / 1`.
   - For `tense === 'imperfect_subjunctive'`, the `-se` variant of the expected form also grades exact (covers `tuviera` / `tuviese`, `hablara` / `hablase`).
6. Capture `wasHintUsed = state.hintUsed`, then apply **Hint-cap** if `wasHintUsed === true`:
   - `easy (4)` → `hint_easy / 2`
   - `exact (3)` → `hint_correct / 2`
   - `wrong (1)` → `hint_wrong / 1` (unchanged numeric grade, distinct kind for the log)
7. Fetch row (`getConjugationReviewById`).
8. Session-id mismatch or already-rated → race; reply `Card vencida. /done.` and `clearFlow`. (Don't silently drop — the user just typed something and needs feedback.)
9. `next = nextState(cardBefore, grade.grade)`.
10. `rateConjugationCard(...)` — race-safe UPDATE + transactional log insert (with `grade_kind`, `typed_answer`, `hint_used: wasHintUsed`, `cloze_source`).
11. If `ok === false` → race, same fail-loud as step 8.
12. Update flow state: increment `reviewedCount` and `countsByGradeKind[grade.kind]`; reset `hintUsed = false`; clear `currentCardId/Expected/Tense/Pattern/Person/Lemma/Sentence/ClozeSource`; `queueIndex += 1`.
13. Send result render (`renderResult(grade, row, next.due)`).
14. `logUsage({ action: "conj.rate", args: { reviewId, lemma, tense, person, gradeKind: grade.kind, grade: grade.grade, hintUsed: wasHintUsed, clozeSource } })`.
15. `serveNextCard()`.

### `endConjFlow()`
Same shape as `endSrsFlow`. Persists `/done`, prints `Stopped.` summary with pattern name + countsByGradeKind + session counts, `clearFlow`.

## Diff/grading details (`src/fsrs/conj-grading.ts`)

```ts
function collapseSpaces(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}
function normalize(s: string): string {
  return collapseSpaces(s).toLowerCase();
}

// Imperfect subjuntivo `-ra` / `-se` equivalence.
function raToSe(form: string, tense?: string): string | null {
  if (tense === 'imperfect_subjunctive') {
    return form.replace(/(ra|ras|ramos|rais|ran)$/, m => ({
      ra: 'se', ras: 'ses', ramos: 'semos', rais: 'seis', ran: 'sen',
    } as const)[m as 'ra' | 'ras' | 'ramos' | 'rais' | 'ran']);
  }
  if (tense === 'pluperfect_subjunctive') {
    return form.replace(/^(hubiera|hubieras|hubiéramos|hubierais|hubieran)\b/, m => ({
      hubiera: 'hubiese',
      hubieras: 'hubieses',
      hubiéramos: 'hubiésemos',
      hubierais: 'hubieseis',
      hubieran: 'hubiesen',
    } as const)[m as 'hubiera' | 'hubieras' | 'hubiéramos' | 'hubierais' | 'hubieran']);
  }
  return null;
}

export function gradeAnswer(
  typed: string,
  expected: string,
  tense?: string,
): { kind: 'exact' | 'wrong' | 'easy'; grade: 1 | 3 | 4 } {
  if (typed.trim() === '/easy') return { kind: 'easy', grade: 4 };
  const tn = normalize(typed);
  const en = normalize(expected);
  const alt = raToSe(expected, tense);
  const enAlt = alt ? normalize(alt) : null;
  if (tn === en || tn === enAlt) return { kind: 'exact', grade: 3 };
  return { kind: 'wrong', grade: 1 };
}
```

Notes:
- **Accent-sensitive.** `tuvé` vs `tuve` is wrong, not "hard." Accents are part of Spanish spelling.
- Case is fully ignored — `TUVE`, `Tuve`, `tuve` all score exact.
- **Whitespace collapse** for compound tenses (`he  comido` → exact match against `he comido`).
- **`-ra`/`-se` equivalence** applies to `imperfect_subjunctive` (`tuviera` / `tuviese`) and the auxiliary in `pluperfect_subjunctive` (`hubiera hablado` / `hubiese hablado`). It does not apply in other tenses. The caller threads the tense through from `conjugation_reviews.tense`.
- The hint-cap transformation (`exact → hint_correct`, etc.) lives in `continueConjFlow`, not here — `gradeAnswer` stays a pure function of the typed text + expected form, independent of session state.
- Function is pure and unit-tested in isolation.

## Hint shapes (`src/telegram/conj-hints.ts`)

`buildHint({ pattern, tense, person, expected_form })` returns a one-line cue that points at the rule without giving the form. Pure function; 33 templates, one per pattern. Templates fall into three families:

**Stem-leak (irregular-stem patterns)** — reveal the stem prefix, but never the full expected form:
```
present_yo_go             → "yo stem: teng-" (tener), "yo stem: salg-" (salir)
present_yo_zco            → "yo stem: conozc-" (conocer)
preterite_strong          → "stem: tuv-" (tener), "stem: dij-" (decir)
future_irregular_stem     → "stem: tendr-" (tener), "stem: sabr-" (saber)
conditional_irregular_stem → same stem as future: "stem: tendr-"
imperfect_subj_strong_stem → "stem: tuvie-" (-ra/-se both accepted)
present_subj_yo_irreg_derived → "yo-irreg stem: teng-" (then add subj ending)
imperative_affirmative_tu_irreg → "tú: short irregular imperative; think decir/hacer/ir/poner/salir/ser/tener/venir"
```
The stem is computed from `expected_form` by chopping the canonical person-ending for that tense.

**Rule-leak (regular patterns)** — reveal the ending only:
```
present_regular_ar/er/ir   → "presente -ar/-er/-ir, 1ps ending: -o"
preterite_regular_ar       → "pretérito -ar, 2ps ending: -aste"
preterite_regular_er_ir    → "pretérito -er/-ir, 3pp ending: -ieron"
imperfect_regular          → "imperfecto -ar/-er/-ir, 1pp ending: -ábamos/-íamos"
future_regular             → "futuro: infinitivo + endings (-é/-ás/-á/...)"
conditional_regular        → "condicional: infinitivo + endings (-ía/-ías/-ía/...)"
present_subj_regular       → "presente subj -ar→e-, -er/-ir→a-"
imperfect_subj_regular     → "imperfecto subj: 3pp pretérito stem + -ra/-se"
imperative_affirmative_regular → "tú = 3ps presente; usted = presente subj"
imperative_negative        → "= presente subj (always)"
```

**Aux-leak (compound patterns)** — reveal the haber form:
```
present_perfect            → "aux: he/has/ha/hemos/habéis/han + participio"
pluperfect                 → "aux: había/habías/había/... + participio"
future_perfect             → "aux: habré/habrás/... + participio"
conditional_perfect        → "aux: habría/habrías/... + participio"
present_perfect_subj       → "aux: haya/hayas/haya/... + participio"
pluperfect_subj            → "aux: hubiera/hubieras/hubiera/... + participio"
```
For compound tenses, the hint reveals the auxiliary paradigm + flags that a participle follows. The user still has to recall the participle (which is the part most likely to trip them up — irregular participles).

**Irregular-set patterns** (`present_irregular`, `present_subj_irregular`, `imperfect_irregular`) — small enough sets that the hint names the verb family, but still must not include the current expected form:
```
present_irregular (ser)    → "ser: fully irregular present; recall the ser paradigm"
present_irregular (ir)     → "ir: fully irregular present; recall the ir paradigm"
imperfect_irregular (ser)  → "ser: one of the three irregular imperfect verbs"
```

Invariant: `buildHint(...)` must not contain `expected_form` as a substring after case-insensitive whitespace normalization. If a rule template would leak the answer for a short form (`sé`, `ve`, `he`, `era`), return the family/rule hint instead.

`buildHint` is pure; tested per pattern with a representative verb. Failure mode (unknown pattern) returns `"sin pista disponible"` — never throws.

## Pattern classifier (`scripts/lib/pattern-classifier.ts`)

The vendored verbecc-derived JSON must expose a template id/name when available plus raw normalized forms. The classifier:

1. Reads `{ lemma, tense, person, form, template }`.
2. Returns one of the 33 pattern names enumerated above.
3. Applies person-scoped rules before tense-level fallbacks. Example: `tener · present_indicative · yo` is `present_yo_go`, while `tener · present_indicative · tú` is `present_stem_eie`; `pedir · preterite · él` is `preterite_stem_iu`, while `pedir · preterite · yo` is `preterite_regular_er_ir`.
4. Falls through to `(tense)_regular` for any cell whose template/form doesn't match the irregular rules — guards against missing a future verbecc addition.
5. Handles the compound-tense lumping (regular and irregular participles share one bucket per tense) and the `imperative_affirmative_tu_irreg` 8-verb hardcoded set.

The classifier is **pure**, takes `(lemma, tense, person, form, verbecc_template_id)` and returns a string. No DB. Test fixture: ~30 representative verbs (one per bucket + edge cases), exercised in `tests/tools/pattern-classifier.test.ts`.

## Telemetry actions (`usage_logs`)

| action | args |
|---|---|
| `conj.start` | `{ pattern, cap, queueSize }` |
| `conj.start` (empty) | `{ reason: 'no_candidates' \| 'soft_block' }`, ok=true |
| `conj.serve` | `{ reviewId, lemma, tense, person, pattern, frequencyRank, clozeSource: 'corpus'\|'generated' }` |
| `conj.hint` | `{ reviewId, lemma, tense, person, pattern }` — fired exactly when `/hint` is honored (not on the second-hint reject) |
| `conj.rate` | `{ reviewId, lemma, tense, person, gradeKind, grade, hintUsed, clozeSource }` |
| `conj.cloze-gen` | `{ lemma, tense, person, form }` — fired exactly when LLM fallback runs |
| `conj.race` | `{ reviewId, where: 'serve'\|'rate'\|'continue' }` — stale in-process session or double-submit no-ops |
| `conj.done` | `{ reviewedCount, pattern, hintCount }` |

`activity_logs` is untouched — `/conj` is deterministic, not an agent flow. `usage_logs` is canonical.

## Test plan

| File | Type | Cases |
|---|---|---|
| `tests/tools/conj-grading.test.ts` | pure | `tuve` vs `tuve` → exact; `Tuve` vs `tuve` → exact; **`tuvé` vs `tuve` → wrong** (accent miss is wrong); `tuvi` vs `tuve` → wrong; `/easy` → easy; empty string → wrong; leading/trailing whitespace tolerated; compound: `he comido` vs `he comido` → exact; `He  Comido` (double space, mixed case) → exact; `he comer` → wrong; `-ra`/`-se`: `hablara` vs `hablara` with tense=imperfect_subjunctive → exact; `hablase` vs `hablara` with tense=imperfect_subjunctive → exact; `hablase` vs `hablara` with tense=preterite → wrong; `hubiese hablado` vs `hubiera hablado` with tense=pluperfect_subjunctive → exact; `hubiese hablado` vs `hubiera hablado` with tense=pluperfect → wrong |
| `tests/tools/conj-hints.test.ts` | pure | one assertion per pattern bucket: representative verb produces a non-empty hint that does NOT contain the full `expected_form` as a substring after normalization; `present_yo_go` for `tener · 1ps` includes `teng-`; `preterite_strong` for `decir · 3pp` includes `dij-`; `present_perfect` includes the auxiliary paradigm but not the full expected answer; `imperative_affirmative_tu_irreg` for `tener · tu` does not contain `ten`; `imperfect_irregular` for `ser · yo` does not contain `era`; `imperative_negative` returns the subjuntivo rule; unknown pattern returns `"sin pista disponible"` without throwing |
| `tests/tools/pattern-classifier.test.ts` | pure | `tener · present · yo` → `present_yo_go`; `tener · present · tu` → `present_stem_eie`; `tener · present · nosotros` → `present_regular_er`; `tener · preterite · *` → `preterite_strong`; `pedir · preterite · yo` → `preterite_regular_er_ir`; `pedir · preterite · el` → `preterite_stem_iu`; `pensar · present · tu` → `present_stem_eie`; `pensar · present · nosotros` → `present_regular_ar`; `comer · imperfect · *` → `imperfect_regular`; `ser · imperfect · *` → `imperfect_irregular`; `salir · present · yo` → `present_yo_go`; `tener · future_indicative · *` → `future_irregular_stem`; **`hablar · present_perfect · *` → `present_perfect`; `decir · present_perfect · *` → `present_perfect` (lumping policy, not split by participle irreg)**; **`tener · imperative_affirmative · tu` → `imperative_affirmative_tu_irreg` (expected form: `ten`)**; **`hablar · imperative_negative · tu` → `imperative_negative` (expected form: `hables` — bare subjuntivo)**; unknown template → `(tense)_regular` fallback |
| `tests/tools/conj-flow-pure.test.ts` | pure (mocked `pg.Pool`) | `parseConjArgs` (in-range, out-of-range, empty, garbage); render functions (card front with cloze mask, all four result renders); session-summary render with countsByGradeKind |
| `tests/tools/conj-callback-stale.test.ts` | pure | gradeAnswer + flow-state mutation deterministic — given a state at queueIndex K with currentCardId X, applying `rate(grade=3)` transitions to queueIndex K+1, clears currentCardId, increments counts |
| `tests/integration/import-conjugations.test.ts` | test-DB (5433) | Import a fixture verbecc subset (~30 verbs, ≥1 per pattern bucket) plus a tiny `verb-frequency-es.txt` fixture; raw `yo tuve` normalizes to `form='tuve'`; `tener · preterite · yo` row has `pattern='preterite_strong'`; re-run is idempotent (no duplicates); `comer · imperfect` rows all classified `imperfect_regular`; `hablar · present_perfect · 1ps` row has `form='he hablado'` and `pattern='present_perfect'`; `levantarse · present · yo` raw `me levanto` normalizes to `form='levanto'`; `hablar · imperative_affirmative · yo` row does NOT exist (import skips yo for imperatives); `tener · imperative_affirmative · tu` has `form='ten'`; `hablar · imperative_negative · 2ps` has `form='hables'` (bare subjuntivo, no leading `no`); `vos` rows are dropped; `frequency_rank` matches the position in the fixture frequency file (e.g. `ser`=1, `tener`=2); verbs absent from the fixture frequency file get `frequency_rank=NULL` |
| `tests/integration/cloze-source-compound.test.ts` | test-DB | Seed an `entries` row with "Ya he comido hoy"; `findClozeSentence({ lemma:'comer', form:'he comido' })` returns it; multi-word literal match works; English "he went home" is ignored; `findClozeSentence({ lemma:'hablar', form:'hables', tense:'imperative_negative' })` requires the leading `no` — sentence "Quiero que hables" does NOT match, "No hables tan rápido" does match |
| `tests/integration/conjugation-reviews.test.ts` | test-DB | `pickPatternForSession` cold-start follows `CONJ_PATTERN_BOOTSTRAP_ORDER` and skips patterns with no ranked unpromoted candidates; existing-review selection prefers due count, then avg lapses, then least-recently-drilled; `buildConjugationQueue` promotes up to cap in `frequency_rank ASC NULLS LAST` order — common verbs first; rare verbs (NULL rank) promoted only when all ranked candidates exhausted; race-safe rate (double-call returns false for second); status='suspended' excluded; session counts (M / K / J) |
| `tests/integration/conj-flow-hint.test.ts` | test-DB | `/hint` reveals the pattern's hint, doesn't advance, sets `state.hintUsed=true`; subsequent correct answer rates `grade_kind='hint_correct'`, `rating=2`, `hint_used=true` in the log; subsequent wrong rates `hint_wrong`, `rating=1`; subsequent `/easy` rates `hint_easy`, `rating=2`; second `/hint` on same card returns the rejection message without logging another `conj.hint`; `hintUsed` resets to false on next card |
| `tests/integration/cloze-source.test.ts` | test-DB | Seed an `entries` row with "Cuando era joven, viajé mucho"; `findClozeSentence({ lemma:'ser', form:'era' })` returns that sentence trimmed; word-boundary works (`era` matches but `verdadera` does not); English "the modern era" is rejected by `looksSpanish`; rotate by reps cycles candidates; null when no hits |
| `tests/integration/conj-flow.test.ts` | test-DB | Full lifecycle: start → first card served with cloze → correct answer rates 3 → next card served → /done → summary. Plus: `/easy` grades 4; wrong answer grades 1 with correction render; unknown slash does not grade and leaves card open; non-slash garbage grades wrong; soft-block on active flow; simulated internal stale state with active conj but `currentCardId=null` → fail-loud reply; full bot-restart behavior is only "no DB write after flow state loss" because flow state is in-memory by design |
| `tests/integration/conj-router.test.ts` | test-DB | `/conj` registered; `/hint` is **not** registered globally; `/conj 30` valid; typed answer while in conj flow routes to `continueConjFlow` BEFORE the srs prose-nudge; `/hint` while in conj routes to `continueConjFlow`; `/hint` with no active flow is unknown command; `/done` while in conj routes to `endConjFlow` |

Fixture verb subset for the import test: include at least one verb per pattern bucket (~30 verbs across 33 buckets, ~3k rows after the 15-tense expansion) to keep test imports fast and exhaustive.

## `pnpm check` surface

- `src/db/queries/conjugations.ts`, `src/db/queries/conjugation-reviews.ts`, `src/db/queries/cloze-source.ts` enter the **100%-coverage** queries bucket (match the existing `vocab-reviews.ts` precedent). Cover every empty-result branch and the cold-start fallback path.
- `src/telegram/flows/conj.ts`, `src/fsrs/conj-grading.ts`, `src/llm/cloze-gen.ts` fall under global **95/95/90/95**. Extract render and state-mutation helpers as pure functions so branchy logic is testable without a Telegram mock. The flow itself only needs ~6 integration cases to cover its branches.
- `scripts/import-conjugations.ts`, `scripts/lib/pattern-classifier.ts` are scripts — pure classifier is tested; the import driver is exercised via the integration test.
- `data/conjugations-es/` is data, no coverage.
- **No existing thresholds move.**

## Out of scope

- Audio playback / TTS of the conjugated form.
- Voice answers (Whisper). Defer; typed input is the signal.
- Multiple-choice mode. Type it or it doesn't count.
- A separate "lesson" surface that teaches the pattern in prose before the quiz. Mitch knows the rules; he needs production reps.
- Non-Spanish languages. The schema is parameterized by `lang` on `vocab_reviews` but `/conj` v1 is hardcoded `es`-only.
- A precomputed `cloze_candidates` table. Lazy-on-demand is the v1 commitment per the brief's escape hatch.
- A `pos` column on `vocab_reviews`. Conjugation lemmas come from the frequency-ranked verbecc list; `vocab_reviews` is not consulted for `/conj` lemma selection at all.
- Progressive multi-step hints (first letter → first syllable → full pattern → answer). One hint per card is the v1 contract.
- Cross-pattern session roll-over. Strict one-pattern-per-session in v1.
- User-overridable pattern selection (e.g. `/conj preterite-strong`). Single-surface command in v1.
- Surfacing `gloss_override` or `status='suspended'` for conjugation cells. Columns reserved; UPDATE-by-hand for v1.
- Writing conjugation state back into the Tomo writer prompt (analogous to the SRS `[stalling]` / `[mastered]` tags). Possible future addition but out of scope here.

## Open questions left deferred

These are explicitly NOT blockers for the v1 spec; flag them as future-work candidates:

- **Precomputed `cloze_candidates` table.** If lazy-on-demand becomes too slow as the corpus grows (current sizes don't warrant it), promote to a precomputed table fed by an offline pass over `entries` + `knowledge_artifacts`.
- **Pattern-level SRS unit.** Ella's Smart Quizzes treat the pattern itself as a card. We do not in v1 — every cell is its own FSRS card — but the log carries `pattern` so we can experiment with pattern-level scheduling later.
- **Cross-language generalization.** `lang` column is everywhere; flipping to French or other would mostly be a different conjugation dataset + pattern enum.
- **Personal-corpus boost on top of frequency rank.** If Mitch's Kindle taps reveal a verb he keeps forgetting, the lemma pool currently doesn't see that signal at all (lemma selection is pure frequency). Revisit if there's a noticeable gap between what he taps and what `/conj` drills.
- **Adaptive hint shape based on miss kind.** If a card keeps failing with the same wrong-stem pattern across reviews, the hint could lean harder on the stem. Out of v1 — single template per pattern.
- **Quality of Hermit Dave list for verbs.** The opensubtitles corpus over-represents spoken/casual register. If high-frequency formal verbs (`considerar`, `establecer`) end up under-ranked, swap in a hybrid list or rerank via a separate verb-frequency source.

## Implementation order (TDD-first per CLAUDE.md)

1. Migration `055-conjugations` in `scripts/migrate.ts` + `specs/schema.sql`. Smoke-test with `pnpm migrate` on dev (port 5434).
2. `scripts/lib/pattern-classifier.ts` + `tests/tools/pattern-classifier.test.ts` — failing tests first.
3. Vendor `data/conjugations-es/` (verbecc) + `data/verb-frequency-es.txt` (Hermit Dave) with their licenses.
4. `scripts/import-conjugations.ts` + `tests/integration/import-conjugations.test.ts`. Joins the frequency list during the verbecc parse.
5. `src/db/queries/conjugations.ts` + `src/db/queries/conjugation-reviews.ts` + their integration tests (rank-aware promotion).
6. `src/db/queries/cloze-source.ts` + `tests/integration/cloze-source.test.ts` (incl. compound + imperative-negative variants).
7. `src/llm/cloze-gen.ts` (stub for tests; real Haiku call gated on `ANTHROPIC_API_KEY`).
8. `src/fsrs/conj-grading.ts` + `tests/tools/conj-grading.test.ts`.
9. `src/telegram/conj-hints.ts` + `tests/tools/conj-hints.test.ts` — one assertion per pattern.
10. `src/telegram/flow-state.ts` edit (add `ConjFlowState` with hint fields).
11. `src/telegram/flows/conj.ts` + `tests/integration/conj-flow.test.ts` + `tests/integration/conj-flow-hint.test.ts`. Extract pure helpers as you go.
12. `src/telegram/router.ts` wiring + `tests/integration/conj-router.test.ts`.
13. `pnpm check` green.
14. `pnpm import:conjugations` against dev DB; smoke-test `/conj` + `/hint` over Telegram with a local tunnel.
15. Production migration before push per CLAUDE.md Main Branch Release Protocol.
16. Update `CLAUDE.md` / `AGENTS.md`.

## Verification (post-implementation)

1. `pnpm check` clean.
2. `pnpm migrate` (dev port 5434) — `\d conjugations` / `\d conjugation_reviews` / `\d conjugation_review_log` match the DDL above.
3. `pnpm import:conjugations` — `SELECT COUNT(*) FROM conjugations` is in the hundreds of thousands to low millions depending on the vendored lemma set; spot-check `SELECT * FROM conjugations WHERE lemma='tener' AND tense='preterite' AND person='yo'` returns `form='tuve', pattern='preterite_strong'`.
4. `pnpm dev` + Telegram: `/conj` → pattern-announce + first card with cloze `___` and hint line.
5. Type correct answer → `✓ form (good) → next in 4d`, next card arrives.
6. Type accent miss (`tuvé` vs `tuve`) → `✗ Expected: tuve` (graded as wrong, not "hard").
7. Type wrong → `✗ Expected: tuve` + filled sentence + `(again → next in 1m)`.
8. Type `/easy` → `⏭ form (easy → next in 7d)`.
8a. **`/hint` walk**: Type `/hint` → `💡 Pista — stem: tuv-`; then type `tuve` → `✓ tuve (hint → hard) → next in 1d`; verify `conjugation_review_log` row has `grade_kind='hint_correct'`, `rating=2`, `hint_used=true`.
8b. **Second `/hint`** on same card → `Ya tienes una pista. Escribe la respuesta o /done.` with no extra `conj.hint` log row.
8c. **Hint then wrong**: `/hint` → type wrong → grade `hint_wrong`, `rating=1`.
8d. **Hint then `/easy`**: `/hint` → `/easy` → grade `hint_easy`, `rating=2`.
9. Type `/done` → `Stopped. Patrón: …` summary including `(N con pista)`.
10. `/conj` while `/practice` active → soft-block reply.
11. Simulate internal stale state (active conj flow with `currentCardId=NULL`) → `Card desincronizada. /done y vuelve a empezar.` reply, no DB write. Simulate full bot restart by `clearAllFlows()` then type the old answer → routes outside conj and does not rate the DB card.
12. Force corpus miss for a rare cell (suspend `vocab_reviews.examples` for a lemma) → `conj.cloze-gen` fires once, `generated_sentence` column populated, subsequent serves of same cell reuse the cached sentence.
13. `SELECT pattern, COUNT(*) FROM conjugation_reviews GROUP BY pattern ORDER BY 2 DESC` shows the session's pattern bucket has rows promoted.
14. **Compound-tense session** (`UPDATE conjugation_reviews SET due=NOW() WHERE pattern='present_perfect' LIMIT 5;` then `/conj 5`): cards render as `Yo ___ hoy. (comer · 1ps · pretérito perfecto)`; type `he comido` → exact; type `he  comido` (extra space) → exact.
15. **Imperative-negative session**: card renders as `Por favor, no ___ tan rápido. (hablar · 2ps · imperativo negativo)`; type `hables` → exact; type `habla` → wrong.
16. **`-ra`/`-se` equivalence**: imperfect-subjunctive cell accepts both `tuviera` and `tuviese` as exact for the same card.
17. **No imperative-yo rows**: `SELECT COUNT(*) FROM conjugations WHERE tense LIKE 'imperative%' AND person='yo'` returns `0`.
18. **Frequency-rank ordering**: `SELECT lemma, frequency_rank FROM conjugations WHERE pattern='present_regular_ar' ORDER BY frequency_rank NULLS LAST LIMIT 10` returns the most-common -ar verbs first (e.g. `estar`, `dar`, `dejar`, …); rare verbs land at the bottom with NULL ranks.
19. **First-session promotion order**: on a fresh DB, `/conj 5` selects the first available `CONJ_PATTERN_BOOTSTRAP_ORDER` pattern, not the largest bucket. Verify promoted cells in that pattern are ordered by `frequency_rank ASC NULLS LAST` and all have non-NULL ranks unless the ranked pool for that pattern is exhausted.
20. Production migration before push (CLAUDE.md Main Branch Release Protocol).
