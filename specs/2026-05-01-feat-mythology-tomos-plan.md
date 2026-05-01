---
title: Add mythology tomo format to Espejo book pipeline
type: feat
status: active
date: 2026-05-01
origin: specs/2026-05-01-mythology-tomos-brainstorm.md
---

# Add mythology tomo format to Espejo book pipeline

## Overview

Add a second tomo format — **myth** — to the Espejo Spanish mini-book pipeline, alongside
the existing essay format. A myth-tomo retells a Greek (or other mythological) story in
B1-level Spanish, picked because the myth's *shape* genuinely resonates with what Mitch's
recent journals and insights have been surfacing. Each myth-tomo is structured as
~1300 words of literary third-person past-tense retelling + an explicit `## El espejo`
bridge section (~500 words, second-person matching essay voice) that names how the myth
maps to lived material + 5–8 `## Para llevarte` bullets that interleave universal myth
lesson with personal resonance.

Myth-mode is **opportunistic**: the planner scores a curated `books/myths.jsonl` corpus
against the week's context and picks myth-format only when fit is genuinely strong.
Otherwise it falls back to essay. Manual flags (`--format=myth`, `--myth=<name>`,
`--no-myth`, `--fresh-plan`) cover the override cases.

## Problem Statement

The current Espejo pipeline produces only essay-format tomos. Essay-mode is the right
default for most weeks — direct, second-person, anchored on a long-arc theme illuminated
by a domain concept. But some weeks have a *mythic shape* (Sísifo when the streak breaks;
Ícaro when the judge pushes too high; Narciso when the mirror-loop spirals) that an essay
can't honor without becoming explanatory. A retold myth, threaded through the lived
material, would land differently — both as a Spanish reading practice (the literary past
gives strong indefinido/imperfecto terrain matching the active grammar focus) and as a
mirror that uses archetypal pattern instead of direct framing.

This isn't theoretical: the brainstorm established that Mitch's themes (escape, racha,
judge, parts, embodiment, return, threshold) map cleanly to a small set of canonical
myths, and a curated corpus pointed at those themes is more authorial than letting an LLM
free-associate Greek mythology each week.

## Proposed Solution

A two-pass planner extension + writer branching + curated corpus, all wired through the
existing `pnpm write-tomo` flow with no breaking changes for essay-mode users.

**Architecture in one paragraph**: the planner gains a corpus-scoring pass that runs
*before* topic selection. If a myth has strong fit (LLM judgment, not numeric threshold)
the planner outputs `format: "myth"` with `myth_name`, `bridge_thesis`, and the same
`source_refs` it would have picked for an essay (sources still feed the bridge section).
The writer branches on `plan.format`: essay path is unchanged; myth path uses a new
SYSTEM prompt that produces the myth-retelling + `## El espejo` bridge + `## Para llevarte`
structure. The bilingual interleave, EPUB build, email send, and rebuild paths are all
markdown-shape-agnostic and need only minor instruction-prompt tuning. State, history,
and CLI args extend with new optional fields preserving backward compatibility.

## Technical Approach

### Architecture

```
pnpm write-tomo  ──▶  scripts/write-tomo.ts (orchestrator, parses CLI flags)
                          │
                          ├─▶ scripts/book/style.ts        (unchanged)
                          ├─▶ scripts/book/state.ts        (TomoRecord +myth_name; helpers +recentMythNames)
                          ├─▶ scripts/book/context.ts      (unchanged — same long-arc + recent pools)
                          ├─▶ scripts/book/myths.ts        (NEW — corpus reader + validator)
                          ├─▶ scripts/book/planner.ts      (extended — corpus-aware, format-aware,
                          │                                  outputs {format, myth_name?, bridge_thesis?})
                          ├─▶ scripts/book/writer.ts       (extended — branches on format)
                          ├─▶ scripts/book/bilingual.ts    (prompt updated for myth register)
                          ├─▶ scripts/book/epub.ts         (unchanged)
                          └─▶ scripts/book/send.ts         (unchanged)

books/
  myths.jsonl                NEW — curated corpus, line-validated on read
  next-plan.json             extended schema (+format, +myth_name, +bridge_thesis)
  history.json               extended schema (+myth_name, optional)
  style.md                   unchanged (regenerated from Español Vivo.md each run)

scripts/book/
  myth-fit-report.ts         NEW — diagnostic: scores corpus vs. current context, no writes
  add-myth.ts                NEW — explicit corpus-add helper (Claude-drafts entry from a name + theme)

Artifacts/Prompt/Write Tomo.md   updated — Phase 1 review surfaces myth-mode signals;
                                  Phase 3 adds myth-specific checks
```

### Implementation Phases

#### Phase 1: Foundation — corpus, schema, no behavioral change

Goal: land the data model and corpus tooling so subsequent phases have something to read.
The pipeline still writes essay-only at the end of this phase.

- **`books/myths.jsonl`** — seed corpus, ~15 entries. Schema (one JSON object per line):
  ```typescript
  interface MythEntry {
    name: string;                  // "Sísifo"
    culture: "greek" | "roman" | "norse" | "mesoamerican" | "other";
    shape: string;                 // one-line theme: "futile repetition + the moment of relief in the descent"
    motifs: string[];              // ["repetition", "punishment", "racha", "judgment", "ascent", "descent"]
    vocabulary_hints: string[];    // ["empujar", "la ladera", "el peso", "la cumbre", "la condena"]
    summary_es: string;            // 2-4 sentences in Spanish, B1-level, factually accurate canon
    added_at: string;              // ISO date
  }
  ```
  Seed names (matched to Mitch's themes from the brainstorm): **Sísifo** (futility +
  judgment), **Ícaro** (judge-led ascent), **Narciso** (mirror-loop), **Orfeo** (looking back
  ruins it), **Prometeo** (gift becomes punishment), **Tántalo** (proximity without
  satiation), **Dédalo** (engineer-father trap), **Pandora** (curiosity as opening),
  **Perséfone** (cyclical return between two worlds), **Atlas** (carrying as identity),
  **Aracne** (judge punishing excellence), **Hércules** (the labors as parts-work
  vignettes — single corpus entry generalizes), **Caronte** (the threshold figure),
  **Hipnos / Tánatos** (sleep and its dark twin), **Antíope** (the part that runs vs.
  the part that's caught).

  Generation approach: write `scripts/book/seed-myths.ts` (one-time, not committed to
  the regular workflow) that takes the 15 names + shapes + theme tags from this plan
  and asks Claude to draft the `summary_es` + `vocabulary_hints` + `motifs` arrays for
  each. Output piped to `books/myths.jsonl`, hand-edited, committed.

- **`scripts/book/myths.ts`** — new module:
  ```typescript
  export interface MythEntry { /* as above */ }

  export async function readMyths(): Promise<MythEntry[]>;
  // Reads books/myths.jsonl line-by-line. On any malformed line: throw with the line
  // number and offending content. No skip-bad-lines (that hides typos in a hand-edited
  // file — per spec-flow analysis #9).

  export function findMyth(myths: MythEntry[], name: string): MythEntry | null;
  // Exact-match. Returns null if not found.

  export function suggestMyths(myths: MythEntry[], name: string, k = 3): string[];
  // Levenshtein-based top-k for "did you mean" — feeds the --myth=<typo> rejection path.
  ```

- **`scripts/book/state.ts`** — schema extension (backward compatible):
  ```typescript
  export type TomoFormat = "essay" | "myth";

  export interface TomoRecord {
    n: number;
    title: string;
    format?: TomoFormat;        // default "essay" if missing on old records
    domain: TomoDomain;          // "mythology" added to enum for myth tomos
    topic: string;
    source_uuids: string[];
    date: string;
    word_count: number;
    word_count_myth?: number;    // only set when format === "myth"
    word_count_bridge?: number;  // only set when format === "myth"
    series_seed?: boolean;
    bilingual?: boolean;
    myth_name?: string;          // only set when format === "myth"
  }

  export function recentMythNames(h: TomoRecord[], n = 8): Set<string>;
  // For corpus-exclusion in the planner — same shape as recentSourceUuids.
  ```
  TomoSummary type widens its `format` to optional with `format ?? "essay"` defaulting
  at read sites (per spec-flow #8 — type currently lies for old records).

- **`scripts/book/myth-fit-report.ts`** — diagnostic CLI (`pnpm tsx scripts/book/myth-fit-report.ts`):
  loads style + history + corpus + current context, runs the corpus-scoring pass only,
  prints a ranked table:
  ```
  myth         score    last fired    reason
  Sísifo       9.2      tomo 0008      racha rota + judge punishment in source 3afb...
  Ícaro        7.8      never          ascent without descent in long-arc insight ...
  Narciso      4.1      never          weak resonance — no mirror-loop motifs this week
  ...
  ```
  Useful for (a) Phase-1 manual review when `--format=myth` is forced, (b) diagnosing
  corpus rot — myths that haven't fired in 90+ days, (c) sanity-checking corpus
  changes (per spec-flow #7).

- **`scripts/book/add-myth.ts`** — explicit corpus-add helper (`pnpm tsx scripts/book/add-myth.ts "Quetzalcóatl" --culture mesoamerican --shape "the feathered serpent who left and is expected to return"`). Drafts the entry with Claude (using the seed prompt), prints a JSON line, opens it for editing, then appends to `books/myths.jsonl` after confirmation. **Why explicit**: prevents typos in `--myth=<name>` from silently growing the corpus (per spec-flow #3).

**Phase 1 acceptance**: corpus exists with 15 entries, `pnpm tsx scripts/book/myth-fit-report.ts` runs and produces ranked output, type-checking passes (`pnpm check`), no behavioral change to `pnpm write-tomo`.

#### Phase 2: Core implementation — planner + writer branch on format

- **`scripts/book/planner.ts`** — extend in three places:

  1. **System prompt** changes from "essay (non-fiction)" hard-coding to a two-step
     decision: *first* judge corpus fit, *then* pick essay or myth. New SYSTEM language
     (replaces the existing top of `planner.ts:6`):
     ```
     You are the editor of a personalized Spanish-language mini-book series for one
     reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

     Each issue is a "tomo" — a standalone ~2000-word piece. Each tomo is one of two
     formats:

     - "essay" (non-fiction) — direct second-person, anchored on a long-running pattern
       illuminated by a domain concept (neuroscience, psychology, philosophy, etc.).
     - "myth" — a Greek (or other) mythological story retold in literary third-person
       past, paired with an explicit bridge section ("El espejo") naming how the myth
       maps to recent lived material.

     Your job, in order:

     1. Score the mythology corpus below against this week's context (long-arc insights
        + recent material). For each myth, judge fit on: motif resonance, shape match
        with current arc, freshness (myths in the last 8 tomos are excluded). Pick the
        top 3 with one-line reasoning each.
     2. Decide format:
        - If the top myth has GENUINELY strong fit — the kind where the bridge section
          would write itself — pick format="myth" with that myth_name.
        - Otherwise pick format="essay".
        - Strong fit means the myth's shape illuminates the week's actual texture, not
          just shares a vague keyword. Sísifo is right for "tried again and again and
          fell back"; it's wrong for "had a frustrating Tuesday."
     3. Pick topic, angle, sources as before. For myth-mode, sources feed the bridge
        section (~500 words of personal material), so 2-4 source UUIDs are enough.
     4. For myth-mode, additionally produce bridge_thesis: one sentence stating what
        the bridge will assert about the connection — so the user can veto the bridge
        framing in Phase 1 review even if the myth pick is fine.

     Hard rules: ... [existing rules carried forward, plus:]
     - Honor the recent_myth_names exclusion list.
     - Honor --no-myth if present in steer (force format=essay).
     - For myth-mode, domain="mythology" (added to the enum).

     Output STRICT JSON only:
     {
       "format": "essay" | "myth",
       "domain": "neuroscience" | ... | "mythology",
       "myth_name": "Sísifo" | null,        // only when format === "myth"
       "bridge_thesis": "..." | null,       // only when format === "myth"
       "topic": "...",
       "angle": "...",
       "title": "...",
       "source_refs": ["uuid1", "uuid2", ...],
       "myth_top3": [                        // always present, for review surfaces
         {"name": "Sísifo", "score": 9.2, "reason": "..."},
         ...
       ]
     }
     ```

  2. **Plan interface & validation**:
     ```typescript
     export type TomoFormat = "essay" | "myth";

     export interface Plan {
       format: TomoFormat;
       domain: Domain;                          // Domain enum gains "mythology"
       myth_name: string | null;
       bridge_thesis: string | null;
       topic: string;
       angle: string;
       title: string;
       source_refs: string[];
       myth_top3: Array<{ name: string; score: number; reason: string }>;
     }

     // validatePlan adds:
     // - if format === "myth": myth_name must be in corpus, bridge_thesis non-empty,
     //   domain === "mythology"
     // - if format === "essay": myth_name === null, bridge_thesis === null,
     //   domain !== "mythology"
     ```

  3. **`plan()` signature** gains `myths: MythEntry[]` and `recentMyths: Set<string>`
     params. Caller in `write-tomo.ts` reads the corpus and passes them in. The user
     prompt assembled in `plan()` includes a new "# Mythology corpus" block (similar to
     long-arc/recent), with each myth formatted as `[myth:Sísifo] greek — futile
     repetition + the moment of relief in the descent | motifs: repetition, judgment,
     racha`.

- **`scripts/book/writer.ts`** — branch on `plan.format`:
  - Existing `write()` stays as the essay path.
  - New `writeMyth(plan, style, context, lookupsBlock, grammarBlock, mythEntry)`
    function with its own SYSTEM prompt:
    ```
    You are writing one tomo — a Spanish mythology mini-book — for a single reader
    (Mitch), an A2/B1 Spanish learner.

    Structure:
    1. Open with the myth as a literary scene in past tense. Third-person.
       Indefinido and imperfecto carry the action — this matches the reader's active
       grammar focus. No "Imagínate..." second-person; no "En este tomo..." preamble.
       Honor the canonical shape of the myth from the corpus entry. Length: roughly
       1100-1500 words.
    2. Then the heading "## El espejo" on its own line.
    3. Then the bridge section: ~400-600 words, second-person ("tu semana", "lo que
       vivías..."), naming how the myth maps to recent lived material. Draw on the
       provided source material — transform, don't quote. The bridge_thesis from the
       plan is your anchor: develop that, don't restate it.
    4. Then "## Para llevarte" with 5-8 bullets that INTERLEAVE universal myth lesson
       with personal-resonance bullets. Do not segregate them. Do not restate the
       bridge thesis verbatim.

    Other rules: [existing essay rules carried forward — gloss technical terms in-
    prose, double-quote dialogue, no markdown other than headings, etc.]
    ```
  - The dispatch function `write(plan, ...)` checks `plan.format` and calls the
    appropriate path. Existing call sites in `write-tomo.ts:205` are unchanged.

- **`scripts/book/writer.ts` parsing**: extend `splitTomo` (currently `writer.ts:103`)
  to handle the `## El espejo` boundary when present:
  ```typescript
  export interface TomoParts {
    title: string;
    body: string;       // for essay; full pre-takeaways for compatibility
    myth?: string;      // myth-format only
    bridge?: string;    // myth-format only
    takeaways: string;
  }

  export function splitTomo(markdown: string): TomoParts;
  // Detects "## El espejo" — if present, splits body into {myth, bridge}.
  // Old essay tomos have undefined myth/bridge.
  ```
  `countWords` extends to return `{total, myth?, bridge?}`. The orchestrator uses
  these to enforce per-section bounds (myth: 1100-1500, bridge: 400-600) — per
  spec-flow #5 a 2200-word all-myth-no-bridge tomo currently passes silently.

- **`scripts/write-tomo.ts`** — orchestrator changes:
  - **CLI flags**: `--format=<essay|myth>`, `--myth=<name>`, `--no-myth`, `--fresh-plan`.
    Validation: `--myth` implies `--format=myth`; `--no-myth` and `--format=myth` are
    mutually exclusive (error early); `--myth=<unknown>` rejects with Levenshtein
    suggestions from `suggestMyths` (per spec-flow #3).
  - **`--fresh-plan`** deletes `books/next-plan.json` before reading — the documented
    escape hatch users currently lack (spec-flow #4).
  - **Saved-plan invalidation extension**: in `loadSavedPlan`, also discard if the
    saved `myth_name` is no longer in the corpus (analogous to the existing UUID
    pool check, write-tomo.ts:170). Throw with a clear "regenerate plan" message.
  - **Forced format with no strong fit**: when `--format=myth` is passed but the
    planner returns its judgment that no corpus entry has strong fit, *exit non-zero*
    with the `myth_top3` list printed and a suggestion: "Use `--myth=<name>` to force
    one, or rerun without `--format=myth` to fall back to essay." Do not silently
    pick the closest (per spec-flow #2).
  - **Steer-honoring with myth flags**: existing `--steer "..."` continues to work.
    `--no-myth` is a structured veto that the planner sees as a hard rule (added to
    the SYSTEM prompt's hard-rules block), not as freeform steer text — they compose.
  - **Word-count guard extension**: when `plan.format === "myth"`, call the
    per-section word-count check. Total target stays 1800–2400; per-section targets
    print as warnings if outside (1100–1500 myth, 400–600 bridge).
  - **History append**: `myth_name`, `word_count_myth`, `word_count_bridge` written
    when format is myth.
  - **Source-UUID exclusion adjustment** (spec-flow #10): myth-tomo source UUIDs are
    half-strength in `recentSourceUuids` — exclude for the last 15 tomos instead of
    30, since myth tomos use sources for only ~500 words (the bridge). Implementation:
    extend `recentSourceUuids(h, fullN, mythN)` so callers can pass `(history, 30, 15)`.

- **`scripts/book/bilingual.ts`** — SYSTEM prompt addendum (spec-flow #6):
  > "If the source markdown contains a `## El espejo` heading, the section above is a
  > literary myth retelling in past tense — translate the EN with matching literary
  > register (no contemporary contractions, retain the third-person past). The section
  > below is a second-person bridge — translate the EN matching essay voice. The
  > `## Para llevarte` bullets interleave myth lesson and personal resonance —
  > maintain a consistent reflective tone across both kinds."

  No structural changes; just register guidance.

- **`scripts/book/rebuild-tomo.ts`** — no code changes needed. The bilingual interleave
  it calls already operates on the markdown shape, which now includes the
  `## El espejo` heading naturally.

**Phase 2 acceptance**: `pnpm write-tomo --format=myth` writes a structurally-valid
myth tomo end-to-end against a corpus entry; `pnpm write-tomo` (auto path) picks myth
when fit is strong and essay when not; `--no-myth`, `--myth=<name>`, `--fresh-plan`
behave per spec; type-checking + tests pass.

#### Phase 3: Workflow integration — Write Tomo prompt + Phase-1/Phase-3 review

- **`Artifacts/Prompt/Write Tomo.md`** — extend Phase 1 review structure to surface
  myth-mode signals when `plan.format === "myth"`:
  - Add a "myth fit" section showing `myth_top3` with scores + reasoning, so user
    can redirect to runner-up via `--myth=<name>`.
  - Print `bridge_thesis` and ask the user to specifically approve the *bridge angle*
    in addition to the myth pick (spec-flow #1 — without this, Phase 1 is a leap of
    faith on the bridge).
  - Spanish-focus section flips emphasis: myth-mode's literary past gives strong
    indefinido/imperfecto terrain naturally — note this explicitly.

- **Phase 3 review checklist** for myth-mode (extends the existing 7-item list in
  `Artifacts/Prompt/Write Tomo.md`):
  1. **Per-section word counts** — myth 1100–1500, bridge 400–600. Existing
     1800–2400 total stays.
  2. **Para llevarte** — same 5–8 bullet rule, plus check that bullets *interleave*
     universal and personal lessons (not segregated).
  3. **Myth fidelity** — does the retelling honor the canonical shape? No invented
     plot points that contradict canon. Stylistic license OK; factual contradiction
     not.
  4. **Bridge legibility** — does the resonance land? Read the bridge cold (without
     the myth above) and check that it stands as recognizable mirror text — not
     just generic essay-voice.
  5. **Register split** — third-person past in myth, second-person in bridge. Spot-
     check: greppable signal is the second-person pronoun frequency (`\b(tú|tu|te|ti|tuyo|tuya)\b`)
     should be near-zero in the myth section and dense in the bridge.
  6. **Existing checks carry over** — tilde slips, source transform, B1 level
     sanity, no English-word breaks.

- **CLAUDE.md / AGENTS.md** — single line in the "What's Out of Scope" or pipeline
  description noting that mythology is a third format option. Minimal edit.

**Phase 3 acceptance**: a manual run-through with a forced `--myth=Sísifo` produces a
tomo that passes the new review checklist; `Artifacts/Prompt/Write Tomo.md` correctly
guides the workflow including the myth-mode branches; Phase 1 surfaces all signals
the user needs to redirect.

## Alternative Approaches Considered

(Carried forward from `specs/2026-05-01-mythology-tomos-brainstorm.md` — see the
brainstorm for full rationale.)

- **Source material origin**: canonical retelling (a) / canonical threaded through
  Mitch's material (b) / personal-myth retelling (c) — chose **(b)**. (a) is decorative,
  (c) risks self-importance.
- **Structure**: myth+bridge (i) / interleaved scene-by-scene braid (ii) / frame-myth-only
  with implicit resonance (iii) — chose **(i)**. (ii) is fragile in B1 Spanish, (iii) is
  beautiful but unforgiving and removes the visible mirror function.
- **Corpus strategy**: curated (A) / free-form planner pick (B) / hybrid (C) — chose
  **(A)**. Mitch's themes are narrow; a curated corpus pointed at them is more
  authorial and prevents Sísifo-every-week defaults.
- **Rotation**: equal-third (X) / opportunistic (Y) / on-demand only (Z) — chose **(Y)**
  with manual override. Forced rotation guarantees thin matches; pure on-demand
  sacrifices the surprise-fit value of the auto-pipeline.

Two implementation alternatives considered during planning and rejected:

- **Numeric fit threshold for myth-mode**: planner outputs a 0–10 score; if score >= N,
  pick myth. Rejected because calibration drifts and hides the actual judgment behind
  a number. LLM judgment ("would the bridge write itself?") is more aligned with the
  aesthetic goal. Numeric scores still appear in `myth_top3` for transparency, but
  they don't gate the decision.
- **Single combined planner+writer pass for myth-mode**: skip the format-decision pass
  and let one prompt handle myth-or-essay end-to-end. Rejected because it breaks the
  Phase-1 review surface — the user needs to see the format decision (and the top-3
  alternatives) *before* writing, and the saved-plan persistence model relies on a
  separable plan artifact.

## System-Wide Impact

### Interaction Graph

`pnpm write-tomo --plan-only` → reads `books/myths.jsonl` (NEW dependency) →
`gatherContext` (unchanged) → `plan(style, recent, longArc, recent, myths, recentMyths,
steer)` (extended signature) → Anthropic Messages API call (system prompt changed,
~30% larger payload due to corpus block) → JSON parse (extended schema) → validation
against corpus (`findMyth`) → save to `books/next-plan.json` (extended schema). On a
subsequent normal run, `loadSavedPlan` (extended) → corpus stale-check → if myth-mode,
`writeMyth` instead of `write` → markdown emitted with `## El espejo` heading →
`splitTomo` (extended) returns `{title, myth, bridge, takeaways}` → `countWords`
(extended) returns per-section breakdown → word-count guard prints per-section
warnings → bilingual interleave (prompt updated) → `buildEpub` (unchanged — markdown
shape is opaque to it) → `sendToKindle` (unchanged) → `appendHistory` (extended record).

### Error & Failure Propagation

- **Empty / missing `books/myths.jsonl`**: planner falls back to essay-only with a log
  warning. Non-fatal. (Spec-flow #9.)
- **Malformed JSONL line**: `readMyths()` throws with line number + offending content.
  Fatal — refuse to plan rather than silently dropping a line, since lines are hand-
  edited authorial decisions.
- **Planner returns invalid format**: `validatePlan` throws (existing pattern at
  `planner.ts:172`).
- **Planner picks myth not in corpus**: validation throws — same pattern as unknown
  source UUIDs.
- **Saved plan references stale myth_name**: `loadSavedPlan` throws "Saved plan
  references myth no longer in corpus: <name>. Delete `books/next-plan.json` and
  re-plan, or use `--fresh-plan`."
- **`--myth=<unknown>`**: orchestrator exits non-zero with Levenshtein suggestions.
- **`--format=myth` with no strong fit**: orchestrator exits non-zero with
  `myth_top3` printed and remediation hint.
- **Writer outputs malformed myth tomo (no `## El espejo` heading)**: `splitTomo`
  returns `myth=undefined`, word-count guard throws "myth-format tomo missing
  `## El espejo` boundary" — fatal, prevents shipping a structurally-broken tomo.

No retry logic added; the existing pattern is fail-fast and rerun manually.

### State Lifecycle Risks

- **`books/next-plan.json` schema drift**: a myth-mode saved plan from before the
  corpus was edited could reference a removed myth. Handled by the new stale-myth
  check in `loadSavedPlan`.
- **`books/history.json` backward compat**: existing records have no `format`,
  `myth_name`, `word_count_myth`, `word_count_bridge`. Reads default to
  `format = "essay"`, undefined for myth-only fields. No migration script needed.
- **Corpus growth out-of-band**: if Mitch hand-edits `books/myths.jsonl` between a
  `--plan-only` and the normal run, the new myth could appear in the saved plan
  even though it wasn't in the corpus at planning time. Acceptable — saved plan
  contains the myth_name explicitly; corpus is consulted only for stale-check and
  match-scoring.
- **Bilingual file naming**: existing pattern `books/tomos/NNNN-bilingual.md` is
  unchanged; myth-bilingual tomos sit in the same path. EPUB filename gets
  `(bilingual)` suffix per the existing rebuild flow.

### API Surface Parity

The "API surface" here is the CLI + saved JSON contract. Both extend
backward-compatibly:

- `pnpm write-tomo` flags: existing flags unchanged. New flags additive.
- `books/next-plan.json` schema: new fields all optional or nullable.
- `books/history.json` schema: new fields all optional.
- `pnpm tsx scripts/book/rebuild-tomo.ts NNNN [--bilingual]` — no changes; reads
  whatever markdown is on disk.

Internal interfaces (`Plan`, `TomoRecord`, `splitTomo` return type) widen but stay
type-safe via TypeScript discriminated unions.

### Integration Test Scenarios

(Cross-layer scenarios that wouldn't be caught by unit tests against mocked
Anthropic responses.)

1. **Auto-pick essay when corpus is empty**: `books/myths.jsonl` is empty / missing →
   `pnpm write-tomo --plan-only` succeeds with `format: "essay"` and a log warning.
2. **Auto-pick myth when fit is strong + reuse saved plan**: with a populated corpus
   and a context that matches Sísifo strongly, `--plan-only` saves a myth plan;
   normal run reuses it; writer produces a tomo with the `## El espejo` heading;
   word counts pass.
3. **Forced `--format=myth` with weak fit**: planner returns `myth_top3` with all
   scores < threshold; orchestrator exits non-zero; nothing is written; saved-plan
   file is not created.
4. **Bilingual interleave on myth tomo**: write a myth tomo, then run rebuild
   `--bilingual` → resulting interleave preserves heading boundaries and produces
   sensible EN register for both myth and bridge sections (manual eyeball check —
   automatable as a smoke test that confirms `## El espejo` survives the round-trip).
5. **Stale-myth saved plan**: save a myth-plan with `myth_name = "Sísifo"`, then
   remove Sísifo from `books/myths.jsonl`, then run normally → orchestrator throws
   the stale-myth error pointing at `--fresh-plan`.
6. **Source-UUID exclusion respects format weighting**: myth tomo uses 4 source
   UUIDs; those UUIDs become eligible again 15 tomos later (not 30).

## Acceptance Criteria

### Functional Requirements

- [ ] `books/myths.jsonl` exists with at least 15 seed entries covering
      Mitch's core themes
- [ ] `pnpm tsx scripts/book/myth-fit-report.ts` prints a ranked table of corpus
      fit scores against current context
- [ ] `pnpm write-tomo` auto-path picks `format: "myth"` when corpus has strong
      fit, `format: "essay"` otherwise, with rationale visible in the log
- [ ] `pnpm write-tomo --format=myth` forces myth-mode (planner picks corpus entry)
- [ ] `pnpm write-tomo --myth=<name>` forces a specific myth; rejects with
      Levenshtein suggestions on typos
- [ ] `pnpm write-tomo --no-myth` forces essay-mode regardless of corpus fit
- [ ] `pnpm write-tomo --fresh-plan` deletes `books/next-plan.json` before running
- [ ] Forced `--format=myth` with no strong corpus fit exits non-zero with `myth_top3`
      printed; nothing written
- [ ] Saved plan referencing a stale myth_name throws with remediation hint
- [ ] Generated myth tomo has structure: `# title` → myth section (1100–1500 words,
      no second-person) → `## El espejo` → bridge section (400–600 words,
      second-person) → `## Para llevarte` (5–8 bullets, mixed universal/personal)
- [ ] `splitTomo` correctly splits myth-format markdown into `{title, myth, bridge,
      takeaways}`; old essay-format markdown still parses to `{title, body, takeaways}`
      with `myth`/`bridge` undefined
- [ ] Bilingual interleave preserves `## El espejo` heading and produces register-
      consistent EN for both sections
- [ ] `Artifacts/Prompt/Write Tomo.md` Phase 1 surfaces myth_top3, bridge_thesis,
      and the format decision before user approval
- [ ] `Artifacts/Prompt/Write Tomo.md` Phase 3 includes per-section word counts,
      myth fidelity, bridge legibility, and register split checks
- [ ] `pnpm tsx scripts/book/add-myth.ts <name>` is the documented path to grow the
      corpus; `--myth=<unknown-name>` does NOT auto-add

### Non-Functional Requirements

- [ ] `pnpm check` passes (typecheck + eslint + vitest with coverage thresholds)
- [ ] No additional database queries — myth-mode reads from filesystem only
- [ ] Anthropic API token usage for myth-mode planner is within ~1.3× of essay-mode
      (corpus block adds ~3KB)
- [ ] Existing essay-mode behavior is byte-identical to pre-change for the same
      inputs (verify by replanning against a frozen context snapshot)

### Quality Gates

- [ ] At least one auto-fired and one manually-fired myth tomo shipped end-to-end
      to Kindle and reviewed at Phase 3 quality
- [ ] No regressions in essay-mode planning or writing (last essay tomo replays
      identically given frozen inputs)
- [ ] Documentation: `Artifacts/Prompt/Write Tomo.md` updated; `CLAUDE.md`
      mentions the new format

## Success Metrics

- **Resonance**: in the first 5 myth tomos shipped, at least 4 produce a Phase-3
  review where the bridge legibility check passes without rewriting (i.e., the
  resonance landed without manual repair).
- **Auto-firing accuracy**: across the next 10 tomos, when myth-mode auto-fires,
  user agreement rate at Phase 1 (no `--no-myth` redirect) is >= 80%.
- **Corpus utilization**: within 6 months, at least 8 of the 15 seed myths have
  fired at least once. Myths that haven't fired by then are candidates for
  removal or `shape` rewrite.
- **No essay regression**: essay-mode tomos written post-change pass Phase 3 at
  the same quality bar as pre-change (no new tilde slips, register issues, or
  structural drift introduced by the planner SYSTEM rewrite).

## Dependencies & Risks

### Dependencies

- **Anthropic API** — already a dependency. Planner adds corpus block to system
  payload (~3KB), well within model context.
- **No new npm packages** — Levenshtein for `suggestMyths` can use a tiny inline
  implementation (it's <30 lines). No need to pull a dependency.
- **No DB schema changes** — myth corpus is filesystem-only.
- **No CI changes** — `pnpm check` covers the new code.

### Risks

- **Risk: planner over-picks myth-mode** (every week reads as Sísifo). Mitigation:
  the `recentMythNames(h, 8)` exclusion + the LLM-judgment "bridge writes itself"
  bar. Diagnostic via `myth-fit-report.ts`.
- **Risk: planner under-picks myth-mode** (never fires despite real fits).
  Mitigation: `myth-fit-report.ts` prints the ranked scores so user can detect
  systematic under-firing and adjust corpus shapes / system prompt.
- **Risk: bridge feels tacked-on** in early drafts. Mitigation: `bridge_thesis`
  in the plan + Phase-1 review of that thesis. If still happens at Phase 3,
  iterate the writer SYSTEM prompt.
- **Risk: register slippage in writer output** (second-person creeps into myth
  section, or third-person creeps into bridge). Mitigation: register-split grep
  in Phase 3 review; tighten writer SYSTEM with negative examples if recurrent.
- **Risk: bilingual myth tomos read awkwardly in EN** because of literary past
  register. Mitigation: bilingual SYSTEM prompt addendum; manual review on the
  first few; iterate if needed.
- **Risk: corpus seed quality varies**. Mitigation: hand-edit pass after the
  Claude-drafted seeds before committing. `summary_es` factual accuracy is the
  main concern — verify each myth against a canonical source (Hesiod / Ovid /
  the relevant primary text).

### Out of Scope

- Norse / Mesoamerican / Hindu / Egyptian seeds at v1 (corpus accepts them via
  schema but seed is Greek-heavy per brainstorm).
- Multi-myth tomos (one tomo, one myth — even if two myths could resonate).
- Auto-generated corpus from prompt without human review (`add-myth.ts` always
  prompts for confirmation).
- Per-myth statistics dashboards beyond `myth-fit-report.ts`.
- Migration of historical fiction tomos (already in `history.json` with
  `format: "fiction"`) into myth format.

## Resource Requirements

- **Effort estimate**: ~6–8 hours over 2–3 sessions.
  - Phase 1 (corpus seed + types + diagnostic): ~2–3 hours including the seed
    drafting + hand-editing pass.
  - Phase 2 (planner + writer + orchestrator changes): ~3–4 hours, dominated by
    the writer SYSTEM prompt iteration to land the structure.
  - Phase 3 (workflow doc + Phase-1/3 review surface): ~1 hour.
- **Test infrastructure**: existing `vitest` + `pnpm check`. New unit tests for
  `myths.ts` (read/validate/find/suggest), `splitTomo` extension, planner schema
  validation. No new fixtures needed beyond a sample corpus.

## Future Considerations

- **Non-Greek corpus expansion**: as Mitch reads more mythology and certain
  archetypes recur in his journals (Norse: Loki / Ragnarök; Mesoamerican:
  Quetzalcóatl / Coyolxauhqui), add via `add-myth.ts`. The schema already
  supports `culture: "norse"` etc.
- **Myth + essay hybrid week**: if the corpus matching ever strongly suggests two
  formats simultaneously, this could become a third format ("ensayo mítico") —
  short essay that opens with a myth vignette. Defer until pattern emerges.
- **Per-myth analytics**: which myths produced the most-reread tomos? Defer
  until shipping rate justifies the analytics.
- **Corpus condensation**: parallel to the existing insight-condensation pass,
  myths could be re-summarized as the corpus grows or as Mitch's themes shift.
  Not needed at v1.

## Documentation Plan

- **`CLAUDE.md` / `AGENTS.md`**: add "Mythology is a second format alongside
  essay; selected opportunistically when the curated corpus has strong fit
  with recent context. See `specs/2026-05-01-mythology-tomos-brainstorm.md` and
  this plan for design." Single section.
- **`Artifacts/Prompt/Write Tomo.md`**: extend Phase 1 review structure;
  extend Phase 3 review checklist; document the new CLI flags in the FAILURE MODES
  section (specifically `--no-myth`, `--myth=<name>`, `--fresh-plan`,
  `--format=myth`).
- **`scripts/book/myths.ts` JSDoc**: schema docs for `MythEntry` so future
  agents understand the corpus contract.
- **No new docs/ pages** — the spec doc + the prompt doc are sufficient.

## Sources & References

### Origin

- **Brainstorm document**: [`specs/2026-05-01-mythology-tomos-brainstorm.md`](./2026-05-01-mythology-tomos-brainstorm.md)
  Key decisions carried forward:
  1. **Threaded canon (b)** — myths picked because they resonate with this week's
     context, not standalone retellings.
  2. **Myth + bridge structure (i)** — clean separation matches existing tomo
     shape; literary past gives indefinido/imperfecto terrain.
  3. **Curated corpus (A)** with **opportunistic firing (Y)** — match-scoring
     drives selection, not rotation parity; corpus growth is authorial.
  4. Greek-preferred-but-not-required; bilingual mode reuses existing pipeline.
  5. `domain` axis replaced for myth-mode (now `domain="mythology"` + `myth_name`).

### Internal References

- Existing essay pipeline:
  - `scripts/write-tomo.ts` (orchestrator)
  - `scripts/book/planner.ts` (essay-only SYSTEM prompt at `planner.ts:6`)
  - `scripts/book/writer.ts` (essay-only SYSTEM prompt at `writer.ts:6`;
    `splitTomo` at `writer.ts:103`)
  - `scripts/book/state.ts` (TomoRecord at `state.ts:19`; `recentSourceUuids` at
    `state.ts:49`)
  - `scripts/book/context.ts` (long-arc + recent gather)
  - `scripts/book/bilingual.ts` (interleave)
  - `scripts/book/rebuild-tomo.ts` (post-edit re-send)
- Workflow:
  - `Artifacts/Prompt/Write Tomo.md` (Phase 0/1/2/3 prompt)
  - `books/style.md` (regenerated from `Artifacts/Project/Español Vivo.md`)
  - `books/history.json` (TomoRecord append-log)
  - `books/lookups.jsonl` and `books/grammar-flags.jsonl` (writer-injected blocks)

### External References

- The brainstorm-recommended seed myths are well-canonized in:
  - **Greek**: Hesiod's *Theogony*, Ovid's *Metamorphoses*, Apollodorus's *Bibliotheca*.
    For B1-Spanish-friendly summaries, the Spanish Wikipedia entries for each myth
    are a reasonable factual baseline.
- **Camus on Sísifo** (`El mito de Sísifo`) is a useful frame for the corpus
  entry's `shape` field — futile repetition + the moment of relief in the descent.

### Related Work

- Recent commit `22051ec` (feat(book): essay-only tomos with long-arc context +
  bilingual option) — established the current single-format pipeline this plan
  extends.
- Spec `specs/2026-05-01-mythology-tomos-brainstorm.md` (origin).
- No prior PRs touching `scripts/book/*` need rebasing.

## Open Questions

(Carried forward from brainstorm + surfaced during planning. None blocking — all
have a chosen default; calling out for visibility.)

- **Threshold for "strong fit"**: chosen LLM-judgment ("would the bridge write
  itself?") rather than a numeric score gate. Numeric scores still appear in
  `myth_top3` for transparency. **Revisit if** auto-firing rate drifts outside
  the 1-in-4 to 1-in-7 zone over 20 tomos.
- **Adding a "Mythology register" section to `books/style.md`**: chosen NO at v1.
  The writer SYSTEM prompt carries the register guidance directly. **Revisit if**
  register drift recurs across multiple Phase-3 reviews.
- **Forced `--myth=<name>` when fit is weak**: chosen — accept the user's
  judgment, write the tomo, but print a "weak-fit warning" so Phase 1 review
  can flag it. Manual override always wins.
- **Single corpus entry for Hércules' twelve labors vs. one entry per labor**:
  chosen single entry at v1 with a `shape` that abstracts the labor pattern.
  **Revisit if** specific labors keep wanting to fire individually — at that
  point, split the entry.
