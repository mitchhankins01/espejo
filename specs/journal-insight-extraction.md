# Journal Insight Extraction — Mine Day One entries into atomic Pending insights

## Status: Planned

## What

Continuous and one-time mining of atomic insights from the corpus of Day One journal entries, written into `Artifacts/Pending/` for human approval through Mitch's existing Pending review workflow. There is no new ritual prompt and no new scheduler.

The going-forward path piggybacks on existing background timers (`src/oura/sync.ts`, `src/obsidian/sync.ts`) — each tick checks for unprocessed entries since the last successful run, runs them through a Haiku 4.5 triage gate (default NO), then Opus extraction with verbatim evidence quotes, then inline duplicate / merge / new classification against `Insight/` ∪ `Pending/`. Duplicates are dropped; merges are written with `merge_target`; new candidates are written standalone.

The one-time backfill ships as a CLI (`pnpm mine-journal`) with two modes — `cluster` (monthly packet-level distillation, captures cross-entry patterns) and `per-entry` (atomic singular moments). Canonical execution order: **run `--mode cluster` first across all 72 packets in chunks, then `--mode per-entry` across years; dedup catches overlap; you only ever see net-new in Pending.**

The pipeline is intentionally zero-default. Most entries produce nothing. False-positive cost > false-negative cost in this corpus — a polluted Insight corpus erodes trust in the entire system.

## Architecture

```
src/
  journal-insights/
    types.ts            — zod schemas: TriageResult, InsightCandidate, Classification, ExtractionRun
    prompts.ts          — versioned prompts: triage, per-entry extraction, cluster extraction
    triage.ts           — Haiku 4.5 gate. Returns YES/NO + one-line reason.
    extract.ts          — Opus 4.7 extraction (per-entry + cluster). Validates evidence is substring of source.
    classify.ts         — Inline duplicate/merge/new decision via cosine on top-1 (no LLM call).
    cluster.ts          — Monthly packet builder + density scoring.
    writer.ts           — Renders provenance frontmatter + body, writes to Artifacts/Pending/.
    runner.ts           — Orchestrator: fetch unprocessed → triage → extract → classify → write. Owns advisory lock.
    cost.ts             — Per-call cost rollup using apiRates from config.ts; written into extraction_runs.meta.
    index.ts            — Public entrypoints: maybeRunJournalExtraction(pool, trigger) and runBackfill(pool, opts).
  db/queries/
    extraction-runs.ts  — CRUD for extraction_runs; lastSuccessfulScanTo(runType), insertRun, completeRun.
    entries.ts          — (extend) listEntriesSince(ts), listEntriesByMonth(yyyy_mm), entryDensityScore(uuid).
    artifacts.ts        — (extend) getNearestInsights(embedding, k) returning rows with embeddings inline.
  oura/sync.ts          — (modify) post-tick hook: maybeRunJournalExtraction(pool, 'oura-tick').
  obsidian/sync.ts      — (modify) post-tick hook: same. Whichever wins the advisory lock executes.
scripts/
  mine-journal.ts       — Backfill CLI. Subcommands: --mode cluster --months <range>, --mode per-entry --year <yyyy>.
specs/
  schema.sql            — (modify) add extraction_runs table.
tests/
  journal-insights/
    triage.test.ts
    extract.test.ts
    classify.test.ts
    writer.test.ts
    runner.test.ts
    cluster.test.ts
  integration/
    journal-extraction.integration.test.ts
```

**Module name rationale.** `src/insights/` is already taken by the existing background dot-connecting worker (`specs/insight-engine.md` — Temporal Echoes, Biometric Correlations, Stale Todos). `src/journal-insights/` is the unambiguous home for this system.

**Integration with existing timers.** Both `src/oura/sync.ts` and `src/obsidian/sync.ts` already follow the `setInterval` + `pg_try_advisory_lock(<id>)` + `notifyError` pattern. After each successful tick (regardless of whether sync had work), each calls `maybeRunJournalExtraction(pool, '<oura|obsidian>-tick')`. The runner acquires its own distinct advisory lock (`pg_try_advisory_lock(9152307)` — distinct from `9152202` used by `insight-engine`). If the lock is held, return immediately. If `lastSuccessfulScanTo('continuous')` is within `INSIGHT_EXTRACTION_MIN_INTERVAL_MIN` of NOW(), return immediately. Otherwise: fetch entries with `GREATEST(created_at, COALESCE(modified_at, created_at)) > last_scan_to`, process, record run.

**Daily cursor.** Derived from `MAX(scan_to)` on the `extraction_runs` row with `run_type='continuous' AND status='success'`. **Backfill runs never advance the daily cursor** — keeps backfill independent so historical mining doesn't suppress new daily extraction.

**Bootstrap.** First-ever continuous run: if no successful row exists, set `scan_from = NOW() − 24h`. Don't try to backfill the entire corpus from a timer tick — backfill is the CLI's job.

## Daily Pipeline

```
existing oura/obsidian sync tick
  └── maybeRunJournalExtraction(pool, trigger)
        ├── pg_try_advisory_lock(9152307)
        ├── debounce: skip if last continuous scan_to < INSIGHT_EXTRACTION_MIN_INTERVAL_MIN ago
        ├── select entries where GREATEST(created_at, modified_at) > last scan_to
        ├── filter by length floor (>= INSIGHT_EXTRACTION_LENGTH_FLOOR words; default 100)
        ├── for each: Haiku triage with top-3 anti-dup Insights → YES/NO
        ├── on YES: Opus extraction with evidence-quote requirement
        ├── evidence substring validation — drop candidates whose evidence is not in source
        ├── inline classify (duplicate / merge / new)
        ├── write merge + new candidates to Artifacts/Pending/
        └── upsert extraction_runs row + per-tool usage_logs row
```

Day One entries can be edited after creation, so the cursor uses `GREATEST(created_at, modified_at)`. A modified entry may contain the actual realization that wasn't there at first write.

## Triage Gate (Haiku 4.5)

Cost-discipline gate. Default NO. Single binary decision, with top-3 most-similar existing Insights injected as anti-duplication context.

**Prompt** (`prompts.ts → TRIAGE_PROMPT_V1`):

```
You are an atomic-insight triage gate for a personal journal.

DEFAULT TO NO. The vast majority of journal entries do NOT contain an extractable atomic insight worth promoting to a permanent note. Travel logs, daily recaps, mood snapshots, gratitude lists, and routine reflections are all NO.

YES only if the entry contains at least one of:
- A recurring pattern named for the first time ("I keep doing X when Y").
- A blind spot or self-deception explicitly surfaced.
- A non-obvious causal claim with evidence ("X causes Y because Z").
- A decision rule the author commits to.
- A reframing that overturns a prior belief.

Anti-duplication context — these insights already exist; if the entry only restates one of them, answer NO:
{{TOP_3_EXISTING_INSIGHTS}}

MODE: {{MODE}}
{{MODE_INSTRUCTION}}

Entry (date={{DATE}}, location={{LOCATION}}):
"""
{{ENTRY_TEXT}}
"""

Respond with strict JSON only:
{"decision": "YES" | "NO", "reason": "<one short sentence>"}
```

`MODE_INSTRUCTION`:
- `per_entry`: "Evaluate this single Day One entry. Say YES only if the entry itself contains a sharp extractable realization. Do not infer from surrounding life context."
- `cluster`: "Evaluate this monthly packet. Say YES only if the packet shows a recurring pattern, blind spot, or non-obvious claim across entries. Do not say YES for a month that is merely eventful."

Output validated by `zod`: `z.object({ decision: z.enum(['YES','NO']), reason: z.string().max(200) })`. On parse failure → coerce to NO, log to `usage_logs` with `ok=false, error='triage_parse_failure'`.

## Extraction Prompts (Opus 4.7)

### Per-entry mode (`prompts.ts → EXTRACT_PER_ENTRY_PROMPT_V1`)

```
You extract atomic insights from a single personal journal entry.

OUTPUT DISCIPLINE
- Default to []. Most entries yield zero insights. Cap output at 2.
- Atomic zettel: one idea per insight. No "the entry describes..." narration.
- Reframe first-person material into atomic third-person claims, but preserve the author's actual conclusion — do not soften, generalize, or therapize.
- Title: a complete declarative sentence stating the claim. No questions, no nouns-only.
- Body: 2–6 sentences. State the claim, the mechanism or condition, and the consequence. No throat-clearing.
- evidence: a VERBATIM substring of the entry text supporting the claim. Quote the strongest single sentence. Must be present in the entry exactly — do not paraphrase.
- Preserve sensitive details (names, substances, emotions, relationships) when they're part of the insight. Do not sanitize.

ANTI-DUPLICATION
These insights already exist. If your candidate restates one, do not emit it:
{{TOP_3_EXISTING_INSIGHTS}}

ENTRY (uuid={{UUID}}, date={{DATE}}):
"""
{{ENTRY_TEXT}}
"""

Respond with strict JSON only:
{
  "insights": [
    {
      "title": "<declarative sentence>",
      "body": "<2-6 sentences, third person, atomic>",
      "evidence": "<verbatim substring of entry>",
      "tags": ["<lowercase-hyphenated>", ...]
    }
  ]
}
```

### Cluster mode (`prompts.ts → EXTRACT_CLUSTER_PROMPT_V1`)

```
You distill atomic insights from a single month of personal journal entries. The goal is to surface RECURRING patterns, blind spots, and non-obvious claims that span multiple entries — not to summarize any one entry.

OUTPUT DISCIPLINE
- Cap output at 5 insights for the month. Default to fewer; emit zero if the month is routine.
- Atomic zettel: one idea per insight. Reframe to third-person.
- Title: declarative sentence. Body: 2–6 sentences stating claim + mechanism + consequence.
- evidence: a VERBATIM substring from the SINGLE strongest supporting entry. Quote one sentence. Must appear in that entry exactly.
- source_entry_uuids: list ALL entry UUIDs where this pattern shows up (1–N). The entry whose text you quoted in `evidence` MUST be in the list.
- Preserve sensitive details when they're part of the insight. Do not sanitize.

ANTI-DUPLICATION
These insights already exist. Do not restate them:
{{TOP_10_EXISTING_INSIGHTS}}

MONTH PACKET ({{YYYY_MM}}, {{ENTRY_COUNT}} entries):

— Index (uuid + date + first 200 chars + tags) —
{{PACKET_INDEX}}

— Top {{N_DENSE}} densest entries (full text) —
{{PACKET_FULL_TEXTS}}

Respond with strict JSON only:
{
  "insights": [
    {
      "title": "<declarative>",
      "body": "<2-6 sentences>",
      "evidence": "<verbatim substring of the strongest source entry>",
      "source_entry_uuids": ["<uuid>", "..."],
      "tags": ["<lowercase-hyphenated>", ...]
    }
  ]
}
```

### Evidence guard

`extract.ts` post-validates each insight:
- Per-entry: `entryText.includes(insight.evidence)` must be true.
- Cluster: at least one UUID in `source_entry_uuids` whose source text contains the evidence verbatim.

Matching is case-sensitive after normalizing line endings to `\n`. No fuzzy match.

**Behavior on failure:**
- Daily mode: drop the candidate, log to `usage_logs` (`action='extract', ok=false, error='evidence_not_substring'`, payload in `meta`).
- Backfill mode: retry once with a correction prompt that includes the original output and the validation failure (`"Your previous response had an evidence quote that does not appear verbatim in any source entry. Re-emit insights only with valid verbatim quotes, or [] if no valid insight remains."`). If retry still fails, drop and count in `candidates_dropped_evidence`.

## Inline Classification

For each surviving candidate, decide one of `duplicate | merge | new` against `Insight/` ∪ `Pending/`. Reuses the existing hybrid-RRF retrieval already exposed by `searchArtifacts(...)` in `src/db/queries/artifacts.ts` — does **not** call `scripts/dedup/*.mjs` (those are batch tools that fan out to multiple models for high-stakes reconciliation; per-extraction we want a single deterministic in-process decision).

**Algorithm (`classify.ts → classifyCandidate`):**

1. Embed the candidate (`title + "\n\n" + body`) with `text-embedding-3-small`.
2. `getNearestInsights(embedding, k=10)` — hybrid RRF over `kind='insight'` artifacts in `Insight/` and `Pending/` (excluding `deleted_at IS NOT NULL`). Returns rows with embeddings inline.
3. Compute cosine similarity between candidate embedding and each retrieved row's embedding. Rank by cosine.
4. Decide based on `cos_top1`:
   - `cos_top1 ≥ 0.88` → **duplicate**. Log to `usage_logs` (`action='classify', meta={outcome:'duplicate', target:<title>, cos:<n>}`). Do not write.
   - `0.72 ≤ cos_top1 < 0.88` → **merge**. Write to Pending with `merge_target: <top1.title>`.
   - `cos_top1 < 0.72` → **new**. Write standalone.
5. Tag overlap is a tiebreaker only — if two top candidates land within 0.02 cosine, prefer the one with ≥1 shared tag.

**Threshold rationale.** `text-embedding-3-small` cosine distributions concentrate in the 0.5–0.95 band for related concepts. 0.88 is empirically near "same idea, different phrasing" in this embedding space; 0.72 is "related but additive." These match the cosine bands the existing dedup pipeline uses internally. Tunable via env vars; revisit after first backfill chunk if false-merge rate is too high.

**Why cosine on top-1 instead of RRF score thresholds.** RRF scores aren't directly comparable across query sizes (they depend on candidate-pool size, k, and rank distributions). Cosine on the candidate-vs-top-1 embedding is monotone, model-stable, and tunable.

## Frontmatter Schema

Every Pending file written by this system carries:

```yaml
---
kind: insight
status: pending
tags:
  - <lowercase-hyphenated>
source_entry_uuids:
  - <uuid>
extraction_run_id: <run_id>            # FK to extraction_runs.run_id
extraction_mode: per_entry | cluster | continuous
extraction_outcome: new | merge        # duplicates aren't written
merge_target: <existing-insight-title> # only when extraction_outcome == merge
model: claude-opus-4-7
triage_model: claude-haiku-4-5-20251001
prompt_version: v1
evidence: |
  <verbatim quote from the strongest source entry>
---
# <title from extraction>

<body from extraction>
```

Filename: `Artifacts/Pending/<slugified-title>.md`. On collision, append `-2`, `-3`, etc. The writer enforces the project rule that there is no blank line between closing `---` and the `# heading`.

`extraction_outcome: continuous` is the daily-pipeline value (per-entry by unit, but distinct from one-time backfill per-entry; the `extraction_run_id` prefix already disambiguates, but the outcome enum is per the input plan).

## DB Schema Changes

Add an `extraction_runs` table for daily-cursor state and per-run audit. Cleaner than overloading `usage_logs` (event stream) or `daily_metrics` (health data).

**Migration `specs/schema.sql` (new section):**

```sql
CREATE TABLE IF NOT EXISTS extraction_runs (
  run_id                       TEXT PRIMARY KEY,            -- continuous-2026-04-26T14-03-00Z, cluster-2024-Q1, per-entry-2020
  run_type                     TEXT NOT NULL CHECK (run_type IN ('continuous', 'backfill')),
  mode                         TEXT NOT NULL CHECK (mode IN ('per_entry', 'cluster')),
  status                       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  trigger                      TEXT,
  scan_from                    TIMESTAMPTZ,
  scan_to                      TIMESTAMPTZ,
  range_start                  DATE,                        -- for backfill
  range_end                    DATE,                        -- for backfill
  entries_processed            INT  NOT NULL DEFAULT 0,
  packets_processed            INT  NOT NULL DEFAULT 0,
  triage_yes                   INT  NOT NULL DEFAULT 0,
  candidates_generated         INT  NOT NULL DEFAULT 0,
  candidates_written_new       INT  NOT NULL DEFAULT 0,
  candidates_written_merge     INT  NOT NULL DEFAULT 0,
  candidates_skipped_duplicate INT  NOT NULL DEFAULT 0,
  candidates_dropped_evidence  INT  NOT NULL DEFAULT 0,
  cost_usd                     NUMERIC(10,4) NOT NULL DEFAULT 0,
  prompt_version               TEXT NOT NULL DEFAULT 'v1',
  error                        TEXT,
  meta                         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_continuous_success
  ON extraction_runs (scan_to DESC)
  WHERE run_type = 'continuous' AND status = 'success';

CREATE INDEX IF NOT EXISTS idx_extraction_runs_started
  ON extraction_runs (started_at DESC);
```

`lastSuccessfulScanTo('continuous')` reads `MAX(scan_to)` from this table where `run_type='continuous' AND status='success'`. Backfill rows have NULL `scan_to` and never affect the daily cursor.

No changes to `knowledge_artifacts` in v1. Provenance lives in markdown frontmatter and is preserved by `src/obsidian/sync.ts` round-trip. (See Open Questions for the orthogonal `status` column gap.)

## Files to create

| Path | Role |
|---|---|
| `src/journal-insights/types.ts` | zod schemas for triage, candidate, classification, run record |
| `src/journal-insights/prompts.ts` | versioned prompt templates (`v1`) |
| `src/journal-insights/triage.ts` | Haiku gate with anti-dup context injection |
| `src/journal-insights/extract.ts` | Opus extraction (per-entry + cluster) with evidence guard + backfill retry |
| `src/journal-insights/classify.ts` | Inline duplicate/merge/new decision |
| `src/journal-insights/cluster.ts` | Monthly packet builder + density scoring |
| `src/journal-insights/writer.ts` | Frontmatter rendering + Pending file write |
| `src/journal-insights/runner.ts` | Orchestrator + advisory lock + run-record bookkeeping |
| `src/journal-insights/cost.ts` | Per-call cost rollup using `apiRates` from `config.ts` |
| `src/journal-insights/index.ts` | Public entrypoints |
| `src/db/queries/extraction-runs.ts` | DB helpers for the new table |
| `scripts/mine-journal.ts` | CLI entry for backfill modes |
| `tests/journal-insights/triage.test.ts` | Triage unit tests |
| `tests/journal-insights/extract.test.ts` | Extraction unit tests including evidence-guard + retry |
| `tests/journal-insights/classify.test.ts` | Classification threshold tests |
| `tests/journal-insights/writer.test.ts` | Frontmatter rendering tests |
| `tests/journal-insights/runner.test.ts` | Lock + bookkeeping tests |
| `tests/journal-insights/cluster.test.ts` | Packet builder + density tests |
| `tests/integration/journal-extraction.integration.test.ts` | End-to-end against test PG with seeded entries |

## Files to modify

| Path | Change |
|---|---|
| `specs/schema.sql` | Add `extraction_runs` table + indexes (see DB Schema Changes). |
| `src/oura/sync.ts` | After successful tick (regardless of work), `await maybeRunJournalExtraction(pool, 'oura-tick')`. Don't block oura on extraction failure — wrap and `notifyError`. |
| `src/obsidian/sync.ts` | Same hook. Whichever wins the lock executes. |
| `src/db/queries/index.ts` | Re-export `extraction-runs.ts`. |
| `src/db/queries/entries.ts` | Add `listEntriesSince(ts)`, `listEntriesByMonth(yyyy_mm)`, `entryDensityScore(uuid)` (length × `ts_rank` proxy). |
| `src/db/queries/artifacts.ts` | Add `getNearestInsights(embedding, k)` returning rows with embeddings inline. |
| `src/config.ts` | Add journal-insight env vars; verify `apiRates` for `claude-opus-4-7` + `claude-haiku-4-5-20251001` are current (per the auto-memory pricing reminder). |
| `package.json` | Add `mine-journal` script. |
| `CLAUDE.md` | Move this spec from Planned to Implemented when shipped; add `pnpm mine-journal` to Quick Start variants. |

## Config

| Env var | Default | Purpose |
|---|---|---|
| `JOURNAL_INSIGHT_ENABLED` | `true` | Master switch. `false` keeps timers running but skips extraction. |
| `JOURNAL_INSIGHT_MIN_INTERVAL_MIN` | `30` | Min minutes between continuous runs (debounce). |
| `JOURNAL_INSIGHT_LENGTH_FLOOR` | `100` | Per-entry mode word floor. |
| `JOURNAL_INSIGHT_TRIAGE_MODEL` | `claude-haiku-4-5-20251001` | Triage model. |
| `JOURNAL_INSIGHT_EXTRACT_MODEL` | `claude-opus-4-7` | Extraction model. |
| `JOURNAL_INSIGHT_DUP_THRESHOLD` | `0.88` | Cosine ≥ this → duplicate. |
| `JOURNAL_INSIGHT_MERGE_THRESHOLD` | `0.72` | Cosine ≥ this → merge. |
| `JOURNAL_INSIGHT_CLUSTER_TOP_DENSE` | `8` | Number of full-text dense entries per cluster packet. |
| `JOURNAL_INSIGHT_MAX_PER_ENTRY` | `2` | Cap on insights per entry. |
| `JOURNAL_INSIGHT_MAX_PER_CLUSTER` | `5` | Cap on insights per monthly packet. |
| `JOURNAL_INSIGHT_PROMPT_VERSION` | `v1` | Stored in run audit + frontmatter. |

All flow through `src/config.ts`. Update `apiRates` if Haiku 4.5 / Opus 4.7 pricing has changed since the last edit.

## Tests

Coverage targets: 100% on `triage.ts`, `extract.ts` (especially evidence guard + retry path), `classify.ts`, `writer.ts`. Global thresholds (95/95/90/95) on the rest.

**Unit cases:**

- `triage.test.ts`
  - Returns `NO` on a routine "ate breakfast went for a walk" entry.
  - Returns `YES` on entry containing an explicit decision rule.
  - Returns `NO` when entry restates a top-3 anti-dup insight verbatim.
  - Malformed JSON from model → coerces to `NO`, logs `ok=false`.
  - Per-entry mode includes per-entry `MODE_INSTRUCTION`; cluster mode includes packet-mode instruction.
- `extract.test.ts`
  - Per-entry: emits 1 insight with declarative title, ≤6 sentence body.
  - Per-entry: drops insight whose `evidence` is not a substring of the source.
  - Cluster: emits insight with multi-UUID `source_entry_uuids` and `evidence` from one of those UUIDs.
  - Cluster: drops insight whose `evidence` matches no listed UUID.
  - Backfill mode: retries once on first evidence failure; second-pass success counted as written.
  - Backfill mode: retry second-pass failure → counted in `candidates_dropped_evidence`.
  - Daily mode: no retry (one-shot).
  - Caps at `JOURNAL_INSIGHT_MAX_PER_ENTRY` / `JOURNAL_INSIGHT_MAX_PER_CLUSTER`.
  - Preserves sensitive details (names, substances) — no sanitization.
- `classify.test.ts`
  - cos=0.95 → `duplicate`, no write.
  - cos=0.78 → `merge` with the top-1 title as `merge_target`.
  - cos=0.50 → `new`.
  - Tag-overlap tiebreaker fires inside the merge band when two candidates are within 0.02.
  - Empty corpus (no insights yet) → always `new`.
- `writer.test.ts`
  - Frontmatter has all required keys in correct order.
  - No blank line between `---` and `# heading`.
  - Filename collision appends `-2`.
  - `merge_target` only present when `extraction_outcome == merge`.
- `runner.test.ts`
  - Skips when `pg_try_advisory_lock` returns false.
  - Skips when last successful scan_to within `JOURNAL_INSIGHT_MIN_INTERVAL_MIN`.
  - Records `extraction_runs` row with accurate counters.
  - On extractor throw, marks run `status='failed', error=<msg>`, does NOT advance cursor.
  - Failed run does not advance daily cursor (next tick re-processes the same entries).
- `cluster.test.ts`
  - Monthly packet returns full texts for top-N densest entries.
  - Density score is `length × ts_rank_avg`, ordered desc.
  - Excludes current (incomplete) month from cluster mode by default.
- `journal-extraction.integration.test.ts`
  - Seed 5 entries (3 routine, 2 high-signal). Inject 2 existing insights — one duplicates one of the high-signal entries.
  - Run `maybeRunJournalExtraction(pool, 'test')`.
  - Assert: 1 file written to `Pending/` (the new high-signal one), 1 duplicate logged, 0 merges.
  - Assert: `extraction_runs` row populated with correct counters and `status='success'`.
  - Assert: provenance frontmatter parseable and matches input UUIDs.
  - Assert: advisory-lock contention skips cleanly when a second invocation runs concurrently.
  - Assert: `pnpm mine-journal --dry-run --mode cluster --months 2024-Q1` performs no writes.

## CLI

`scripts/mine-journal.ts` exposed via `package.json`:

```json
"mine-journal": "tsx scripts/mine-journal.ts"
```

Usage:

```bash
pnpm mine-journal --mode cluster --months 2024-Q1
pnpm mine-journal --mode cluster --months 2024-01..2024-03
pnpm mine-journal --mode per-entry --year 2020
pnpm mine-journal --mode per-entry --months 2020-06..2020-08
pnpm mine-journal --dry-run --mode cluster --months 2024-Q1     # no writes; print plan + cost estimate
pnpm mine-journal --limit 5 --mode per-entry --year 2020         # cap candidates emitted
pnpm mine-journal --prompt-version v2 --mode cluster --months 2024-Q1
```

Args parsed with a tiny zod schema (no `commander` dep — match the rest of `scripts/`). Validates ranges, errors out actionably on bad input.

The CLI:
1. Resolves the entry set for the requested scope.
2. Prints a plan (entries to process, estimated triage + extraction cost).
3. Prompts `[Y/n]` (skip with `--yes`).
4. Executes against **production DB** by default (CLI loads `.env.production.local`, matching the prompt-execution norm in CLAUDE.md). Add `--env=test` to flip to local.
5. Streams progress to stdout (`scripts/` is allowed `console.log`).
6. Writes one row to `extraction_runs` per invocation with `run_type='backfill'`.

## Backfill Run Order ("best of both")

Verbatim canonical sequence: **Run `--mode cluster` first across all 72 packets in chunks, then `--mode per-entry` across years; dedup catches overlap; you only ever see net-new in Pending.**

### Phase A — Cluster pass (~24 chunks, ~3 monthly packets each)

| Chunk | Range | Notes |
|---|---|---|
| A1 | 2019-Q1 | First chunk — eyeball acceptance rate before continuing. |
| A2 | 2019-Q2 | |
| ... | ... | One chunk per quarter through 2026-Q1 (2026-Q2 partial — skip current month). |
| A24 | 2026-Q1 | Last full quarter. |

After A1–A3, eyeball Pending acceptance rate. If <30% accepted, halt cluster pass and move to per-entry.

### Phase B — Per-entry pass (~7 chunks, one per year)

| Chunk | Range | Notes |
|---|---|---|
| B1 | 2019 | Pre-Tomo; expect high new-rate. |
| B2 | 2020 | |
| ... | ... | |
| B7 | 2026 (YTD up to current month) | |

After B1–B2, eyeball acceptance rate. If <30%, halt per-entry and rely on cluster output only.

### Pacing

Mitch clears Pending between chunks. The producer is bounded by Mitch's rhythm — no automatic chunking. Each chunk creates one `extraction_runs` row; review acceptance rate by joining `extraction_runs.run_id` against approved-vs-rejected counts in the vault.

### Cost estimate

- Cluster (~72 packets total, batched ~3 per chunk): Opus ≈ $10–20 + Haiku ≈ $1.
- Per-entry (~3068 entries, ~30% pass triage to Opus): Haiku ≈ $3 + Opus on ~600 entries ≈ $30.
- **Total backfill: ~$50–60 one-time** at current Opus 4.7 / Haiku 4.5 pricing. (Going-forward continuous: <$15/yr.)

## Open questions

1. **`knowledge_artifacts.status` gap.** `status: pending` lives in markdown frontmatter but has no DB column and no current search filter. CLAUDE.md asserts pending artifacts are excluded from semantic search, but that rule is not enforced in `src/db/queries/artifacts.ts`. With this spec increasing the rate of Pending writes, the gap matters more. **Decision needed:** add `status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved'))` + index + filter in `searchArtifacts`/`searchContent` as part of this spec, or split it into a separate spec? Default in this spec: split — keep this spec focused; track the gap as `specs/artifact-status-column.md` (TBD).
2. **Cost ceiling.** Backfill estimate is ~$50–60 at current pricing. OK to proceed at that level, or tighten further (e.g., raise per-entry length floor to 200 words, halving Opus calls)?
3. **Cluster packet boundary on incomplete months.** Default in this spec: skip current month from cluster pass; include only complete months. Add to per-entry mode for current month.
4. **Pending file relocation policy on merge.** When Mitch approves a `merge_target` candidate, does the system auto-merge bodies, or does Mitch hand-merge in Obsidian and delete the loser? Default in this spec: hand-merge — we only annotate the candidate with `merge_target` so Mitch sees the relationship in the review pass.
5. **Prompt iteration cadence.** Bumping `prompt_version` from v1 → v2 leaves v1-extracted artifacts in place. Expected behavior or do we want a "re-run only v1 artifacts" path later? Out of scope for this spec.
6. **Telegram notification on continuous runs.** Silent by default. Should the daily run summarize "wrote N new candidates to Pending" via Telegram when N > 0? Default in this spec: silent — Mitch's existing Pending review rhythm is the surface; new notifications add noise.

## Acceptance criteria

- [ ] `extraction_runs` table created and indexed.
- [ ] `pnpm check` passes (tsc, eslint, vitest with stated coverage).
- [ ] Going-forward extractor fires from both Oura and Obsidian sync ticks; only one wins the lock per cycle.
- [ ] Triage gate defaults to NO; routine entries do not invoke Opus.
- [ ] Every Pending file written by this system has full provenance frontmatter; `evidence` is a substring of at least one referenced source entry.
- [ ] Inline classifier emits `duplicate` / `merge` / `new` correctly under unit tests with thresholds 0.88 / 0.72.
- [ ] Duplicates are not written; they appear only in `usage_logs` and `extraction_runs` counters.
- [ ] Backfill mode retries evidence failure once with a correction prompt; daily mode does not retry.
- [ ] `pnpm mine-journal --mode cluster --months 2024-Q1 --dry-run` prints a plan + cost estimate without writing anything.
- [ ] First production run inserts an `extraction_runs` row with `status='success'` and accurate counters.
- [ ] First A-phase chunk produces ≤8 candidates and Mitch's manual review confirms ≥30% are useful (acceptance gate before continuing the backfill).
- [ ] No `console.log` in `src/`; structured logging only. `scripts/mine-journal.ts` may use stdout.
- [ ] Full extraction round-trip (write Pending → R2 → `src/obsidian/sync.ts` → DB) preserves frontmatter into `knowledge_artifacts`.
- [ ] Failed continuous runs (extractor throws) do NOT advance the daily cursor; next tick re-processes the same entries.

## Deviations from input plan

- **Module name `src/journal-insights/`** instead of `src/insights/` — `src/insights/` is already taken by the existing background dot-connecting worker (Temporal Echoes / Biometric Correlations / Stale Todos; see `specs/insight-engine.md`). Avoiding the namespace collision.
- **Added `extraction_runs` table.** The plan said "decide if needed" — needed, because the going-forward "since last run" check requires durable state and per-run audit counters give us the data to tune thresholds without rerunning. Cleaner than overloading `usage_logs` (event stream) or `daily_metrics` (health data).
- **Cosine-on-top-1 thresholds (0.88 / 0.72) instead of RRF score thresholds.** RRF scores aren't directly comparable across query sizes; cosine on the candidate-vs-top-1 embedding is monotone, model-stable, and tunable.
- **Inline classifier reuses `searchArtifacts` from `src/db/queries/artifacts.ts`, not the `scripts/dedup/*.mjs` modules.** Those scripts fan out to multiple models for high-stakes batch reconciliation; per-extraction we want a single deterministic in-process decision against the same hybrid-RRF retrieval the dedup pipeline ultimately uses. Same SQL, different orchestration.
- **Backfill mode retries evidence failure once with a correction prompt; daily mode does not.** Cost-of-retry is justified for one-time backfill where each entry is a sunk Opus call, but adds latency/complexity for daily where the entry will be re-considered next tick if anything changed.
- **Used `usage_logs` (universal cron/script audit) for duplicate skip and triage parse failure logs, not `activity_logs` (Telegram-conversation audit).** Per the table conventions in CLAUDE.md.
- **Cost estimate revised to $50–60** (was "~$50") at current Opus 4.7 / Haiku 4.5 pricing — surfaced in the cost section so future cost drift triggers a config update.
- **Skipped a per-entry sentiment/time-of-day filter.** Plan explicitly forbade these — restated in acceptance criteria and tests for clarity.
- **Bootstrap behavior for first-ever continuous run.** Plan didn't specify; chose `NOW() − 24h` so the timer doesn't accidentally backfill the entire corpus on first deploy (backfill is the CLI's job).
- **No auto-merge of Pending bodies on `merge_target` approval.** Plan implied merge candidates should land in Pending with `merge_target`; clarified that the human still does the body merge in Obsidian. Keeps the extractor's blast radius tight.
- **Surfaced `knowledge_artifacts.status` column gap as an open question rather than baking it in.** Adding the column + filter is correct but orthogonal to this spec; tracked separately to keep this spec focused.
- **Backfill runs do NOT advance the daily cursor.** Plan didn't address — chose this so historical mining doesn't suppress new daily extraction during a multi-week backfill.
