# Insights Dedup Rewrite

> **Status: Planned** — design accepted via Council Review (2026-04-26). Build a TS script + queries module + thin orchestrator prompt to replace the current `Artifacts/Prompt/Insights Dedup.md` shell-heredoc-SQL approach.

Replace the current shell-driven dedup workflow with `scripts/dedup-insights.ts` + `src/db/queries/insights-dedup.ts` + a rewritten 30-line orchestrator prompt. The current prompt has eight concrete bugs (council-confirmed by Claude Opus 4.7, GPT-5.5, Gemini 2.5 Pro, and qwen2.5:32b in the 2026-04-26 council). This spec captures the bugs, the architectural rationale, and the implementation plan so the build is a focused session.

Council synthesis lives at `/tmp/council/20260426-101129/synthesis.md` (ephemeral) — promote relevant excerpts here before that path is gone.

---

## Why this rewrite

The current `Artifacts/Prompt/Insights Dedup.md` runs as a shell-driven workflow: an LLM agent calls `psql` with heredocs, interpolates user content into SQL strings, runs multi-pass threshold sweeps, and asks the user to confirm classifications. The council surfaced eight concrete bugs and four architectural problems.

### Concrete bugs in the current prompt

1. **SQL injection** via `$$$PENDING_BODY$$$` heredoc and `'$EMB'::vector` interpolation. Any pending body containing `$$`, single quotes, or backslashes breaks or escalates the query. Violates AGENTS.md: "all SQL in queries/, never string interpolation."
2. **`plainto_tsquery` on long bodies kills the BM25 leg.** `plainto_tsquery` ANDs every lexeme. A 200-word pending becomes a query requiring all 200 lexemes to match — returns nothing for most pendings. Mode A is silently semantic-only with extra steps. (Claude's catch, alone among the council.)
3. **`Pending/` IS synced and IS in the DB.** The prompt assumes pending files aren't in the DB and must be embedded at query time. False — `src/obsidian/sync.ts:30` only excludes `.obsidian/`, `.trash/`, `Templates/`. Path filtering (`source_path LIKE 'Pending/%'`) is the only reliable distinction. (GPT's catch, codebase-grounded.)
4. **`status: pending` is not parsed into the DB.** `src/obsidian/parser.ts:19` extracts only `kind`, `created_at`, `updated_at`. Filtering on `status` doesn't work without a parser extension. (GPT's catch.)
5. **Embedding text is inconsistent with indexing.** `scripts/embed-entries.ts:167` embeds `title + body stripped of ## Sources`. The current dedup prompt embeds pending bodies *with* sources, biasing matches toward shared source links rather than content similarity. (GPT's catch.)
6. **Cascading-merge stale embeddings.** After merging B→A, the next pair (A,C) uses A's *old* embedding because the DB hasn't been re-embedded mid-run. Decisions on stale data. (Gemini's catch.)
7. **Date regex is anchored wrong.** `^\d{4}-\d{2}-\d{2}` only matches when the wikilink target *is* the date. `[[2023-01-01 Meeting Notes]]` gets skipped. Should be `(\d{4}-\d{2}-\d{2})` — no `^` anchor. (Gemini's catch.)
8. **Inbound wikilinks silently break on duplicate delete.** Deleting `Insight/Loser.md` leaves `[[Loser]]` references in other notes pointing at nothing. No scan, no rewrite, no warning. (GPT's catch, alone.)

### Architectural problems

1. **Threshold bands as decision rules are wrong.** The `< 0.22 / 0.22-0.25 / 0.25-0.27` bands are UX scaffolding for human review burden, not algorithmic correctness. A model classifying `(A, B)` should read both texts and judge — bands belong to retrieval, not classification.
2. **Append-on-merge degrades insights into junk drawers.** Concatenating new content onto existing insights produces incoherent documents over time. Merge should *rewrite* the canonical insight to integrate the new claim cleanly.
3. **Mode A and Mode B are mostly artificial as separate code paths.** Both are: gather candidates → classify → act. The retrieval source differs (embed-on-the-fly vs DB embedding) and the candidate space differs (1×N vs N²/2), but the classification and apply phases are identical.
4. **`created_at` "never overwrite" preserves drift.** If a merge brings in an earlier dated source, `created_at` should update to that earlier date — that's the whole point of the field. The "never overwrite" rule preserves wrong metadata.

---

## Design

### Boundary: script vs prompt

The dedup workflow becomes a TS script (`scripts/dedup-insights.ts`) with parameterized queries living in `src/db/queries/insights-dedup.ts`. The `Artifacts/Prompt/Insights Dedup.md` prompt becomes a ~30-line orchestrator that invokes `pnpm dedup --dry-run`, presents the plan to the user, and applies on confirmation.

**Rationale:** AGENTS.md mandates "Don't build CLI wrappers for things that can be a prompt or skill (YAGNI)" *and* "all SQL in queries/, never string interpolation." For pure prompt-as-prose work the first rule wins. For SQL-bearing workflows the second rule wins, because shell-heredoc-SQL is provably broken (bug #1 above). The dedup case crosses the boundary: it has SQL.

### Classification: agent-in-context, not per-pair API call

The script's `--dry-run` mode emits a JSON plan listing candidate pairs with bodies, similarity scores, and a recommended action. The orchestrating agent (Claude Code / OpenCode, already running on a frontier model) reads the plan in its main context and classifies each pair as Duplicate, Merge, or Distinct.

**Rationale:** The classification step requires reading both texts and reasoning about whether they make the same claim — embeddings can't do this (high cosine = "close in meaning" but doesn't separate "duplicate" from "adjacent"). Per-pair Sonnet calls in a script loop would cost ~$0.50-1.00 per dedup run and add latency. Since the agent is already running on a frontier model and reviewing the plan with the user anyway, classifying in-context is free and uses a stronger model than Sonnet.

The original Council recommendation was per-pair Haiku, then upgraded to Sonnet 4.5 when cost was relaxed. Final decision (after follow-up reasoning): skip the per-pair API call entirely — agent classifies in its own context.

### Unified pipeline

```
1. Filesystem manifest        — glob Insight/ + Pending/, NFC-normalize paths
2. DB candidate filter        — fetch artifacts where source_path is in manifest
3. Normalize embedding input  — title + body stripped of ## Sources (matches embed-entries.ts)
4. Hybrid RRF retrieval       — semantic (cosine) + lexical (websearch_to_tsquery)
5. Emit JSON plan             — bodies, scores, candidate pairs, action recommendations
6. Agent classifies & user confirms
7. Apply phase (atomic per action):
   - New     → check collision, fs.rename, INSERT into DB with new embedding
   - Duplicate → scan vault for [[Loser]] references, rewrite or warn, fs.unlink, mark deleted
   - Merge    → semantic rewrite of canonical body, union sources, re-embed,
                rewrite inbound wikilinks, fs.unlink loser, mark loser deleted
8. Frontmatter dates          — regex (\d{4}-\d{2}-\d{2}) (no ^ anchor),
                                created_at = min, updated_at = max, always overwrite
```

### Mode handling

`--mode pending` queries the manifest for `source_path LIKE 'Pending/%'`. Each pending is a 1×K retrieval against `Insight/%` candidates.

`--mode existing` queries for `source_path LIKE 'Insight/%'`. Pairwise sweep with cosine threshold (default 0.27) over the result set, ordered by distance ascending.

In both modes the pipeline (steps 3-8) is identical.

### Dry-run by default

The script defaults to `--dry-run`, which prints the plan as JSON and makes zero filesystem or DB mutations. `--apply <plan-id>` actually executes (with the plan re-validated before each action — no time-of-check-to-time-of-use bugs).

---

## Implementation plan

### Files to create

- `src/db/queries/insights-dedup.ts` — parameterized queries:
  - `getInsightCandidatesByPath(pool, sourcePaths)` — manifest-validated rows
  - `getRrfCandidatesForBody(pool, embedding, queryText, scope, limit)` — wraps hybrid RRF, scoped to `kind='insight'`
  - `getPairwiseDuplicateCandidates(pool, threshold, includeIds)` — Mode B sweep
  - `markArtifactDeleted(pool, id)` — soft-delete with `deleted_at = NOW()`
  - `updateArtifactBodyAndInvalidateEmbedding(pool, id, body)` — body update + embedding NULL (re-embed handled separately by `pnpm embed`)

- `src/dedup/manifest.ts` — filesystem glob + NFC normalization.
- `src/dedup/wikilinks.ts` — scan vault for `[[Title]]` references; rewrite/list referrers.
- `src/dedup/frontmatter.ts` — date extraction with `(\d{4}-\d{2}-\d{2})` regex (no anchor), min/max calculation, always-overwrite policy.
- `src/dedup/normalize.ts` — strip `## Sources` from body before embedding (mirrors `embed-entries.ts:167`).

- `scripts/dedup-insights.ts` — CLI orchestrator:
  - Args: `--mode pending|existing`, `--threshold <n>`, `--dry-run` (default), `--apply <plan-id>`
  - Reads `.env.production.local`, opens DB pool from `src/db/client.ts`
  - Emits plan JSON to stdout in dry-run
  - On apply: re-validates plan, executes file ops + DB updates, exits non-zero on any failure
  - Calls `pnpm sync:obsidian` after apply (or instructs user to)

### Files to modify

- `Artifacts/Prompt/Insights Dedup.md` — rewrite as ~30-line orchestrator. References `pnpm dedup`, defines the agent's role (classify, present, confirm), preserves the SETUP / DB FRESHNESS / FILENAME ESCAPING headers as still-relevant context.
- `package.json` — add `"dedup": "tsx scripts/dedup-insights.ts"` script.

### Files to NOT touch (yet)

- `src/obsidian/parser.ts` — adding `status` extraction is out of scope for this rewrite. The current path-based filtering (`source_path LIKE 'Pending/%'`) is reliable. Defer the `status: pending` parser extension to a separate spec if/when it's actually needed.
- `src/db/embeddings.ts` — re-embedding after merge happens via `pnpm embed` post-apply, not inline in the script. Keeps the script focused and avoids stepping into the 100%-coverage critical module.

### Tests

Per AGENTS.md: `pnpm check` must pass with strict coverage (95/95/90/95 global, 100% on critical modules). Test plan:

- `tests/db/queries/insights-dedup.test.ts` — unit tests for each query against test PG with seeded fixtures.
- `tests/dedup/manifest.test.ts` — NFC normalization, glob behavior with special characters in filenames.
- `tests/dedup/wikilinks.test.ts` — reference scanning, rewrite logic, edge cases (escaped brackets, nested links).
- `tests/dedup/frontmatter.test.ts` — regex against fixture wikilink filenames, min/max date calc, NaN handling.
- `tests/dedup/normalize.test.ts` — `## Sources` stripping (mirrors `embed-entries.ts` test).
- `tests/scripts/dedup-insights.test.ts` — integration test: seed DB, run with `--dry-run`, assert plan JSON shape; run with `--apply`, assert filesystem + DB state.

Coverage target: 100% on `src/dedup/*` (treat as critical), 95% on the queries module.

---

## Open questions

These need decisions before implementation. Default positions in **bold** but flag at start of build.

1. **Wikilink rewrite on duplicate delete:** auto-rewrite `[[Loser]]` → `[[Winner]]` across the vault, or leave broken with a warning? Auto-rewrite is correct but invasive — first wrong rewrite costs trust.
   **Default: leave broken with warning + report.** Conservative, lossless, easy to revisit.

2. **`status: pending` parser extension** — worth doing as a follow-up spec? Would let pending-status files inside `Insight/` be detected (proposed merges awaiting review). Out of scope for this rewrite.
   **Default: defer.** Path-based filtering is reliable. Add when there's a real use case.

3. **Re-embedding cadence after merge.** Inline in `--apply`, or rely on `pnpm embed` afterward?
   **Default: rely on `pnpm embed` post-apply.** Keeps script focused, avoids touching `src/db/embeddings.ts` (100% coverage).

4. **Mode B incremental memory** — track which pairs the user has classified-as-Distinct so subsequent runs don't re-ask?
   **Default: no.** Adds complexity (new table or vault-side ledger) for a small win on a manual workflow.

5. **Plan format: JSON, JSONL, or markdown?**
   **Default: JSON.** Easy to parse for `--apply`, easy to grep, easy to diff between dry-runs.

---

## Acceptance criteria

- [ ] All 8 concrete bugs from the council are addressed (verifiable by line in the new code).
- [ ] `pnpm check` passes — strict coverage thresholds met.
- [ ] Running the new prompt against the actual prod vault (with `--dry-run`) produces a sensible plan in <30s.
- [ ] Running with `--apply` correctly executes a small test plan (e.g. 1 merge, 1 duplicate, 1 distinct) without breaking inbound wikilinks or losing source attribution.
- [ ] The new `Insights Dedup.md` prompt is ≤40 lines.
- [ ] `Council Review.md` is updated with a "ran on Insights Dedup, results in spec" note (or this spec is referenced from there).

---

## References

- Council run: `/tmp/council/20260426-101129/` (ephemeral — promote excerpts before deletion).
- Council prompt: `Artifacts/Prompt/Council Review.md`.
- Current dedup prompt: `Artifacts/Prompt/Insights Dedup.md` (to be rewritten).
- AGENTS.md sections: "All SQL in queries/", "RRF Search Implementation", "Code Style", "Don't build CLI wrappers for things that can be a prompt".
- Existing parameterized RRF reference: `src/db/queries/artifacts.ts:620` (`searchArtifacts`).
- Existing embedding text normalization: `scripts/embed-entries.ts:167`.
- Sync exclusion list: `src/obsidian/sync.ts:30`.
- Obsidian parser scope: `src/obsidian/parser.ts:19`.
