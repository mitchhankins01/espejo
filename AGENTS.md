# espejo-mcp

MCP server + Telegram chatbot for semantic journal search over Day One exports in PostgreSQL + pgvector.

## Session Init — Run This First

When you (Claude Code, OpenCode, Codex, or any other agent) open or start working in this directory, run:

```bash
pnpm ingest:sessions --skip-if-fresh 24h
pnpm ingest:activity --skip-if-fresh 24h
```

Both are no-ops if a successful run completed in the last 24 hours. Otherwise they capture:
- Claude Code / OpenCode / Codex session logs → `agent_sessions` table (see `specs/agent-sessions-ingestor.md`).
- ActivityWatch window/web/afk events → `device_events` table (see `specs/2026-05-03-activity-capture-plan.md`, Phase 2). No-ops cleanly when ActivityWatch isn't installed.
- Atuin shell history → `usage_logs` (`source='shell'`) (see plan, Phase 3). No-ops cleanly when atuin isn't installed.
- Screenpipe OCR chunks → `screen_captures` (see plan, Phase 4 — **trial through 2026-05-17**; drop the table + uninstall if no SQL hits `screen_captures` by then). Audio capture disabled because macOS Sequoia + launchd can't deliver the runtime Microphone perm prompt the binary needs (Screen Recording allows manual `+`-add; Microphone does not). No-ops cleanly when Screenpipe isn't installed.

## Development Loop

After EVERY code change, run:

```
pnpm check
```

This runs in order, short-circuiting on first failure:

1. `tsc --noEmit` — Type errors mean interfaces don't match the spec
2. `eslint` — Style violations, unused imports, dead code
3. `vitest run --coverage` — Unit + integration tests with strict coverage thresholds (global 95/95/90/95 and 100% on critical modules)

**Do not commit or move on until `pnpm check` passes.**

If a test fails, read the full error output. Test names map to specs in `specs/tools.spec.ts`. Custom assertion helpers in `tests/helpers/assertions.ts` include `Hint:` messages explaining what to fix.

## Quick Start

```bash
pnpm install
docker compose up -d                    # Dev PG on port 5434
pnpm migrate                            # Apply schema
pnpm sync                               # Sync from DayOne.sqlite (set DAYONE_SQLITE_PATH in .env)
pnpm embed                              # Generate embeddings via OpenAI
pnpm dev                                # Start MCP server (stdio)
```

## Architecture Overview

```
specs/tools.spec.ts   ← Source of truth for all tool definitions
       │
       ├──▶ src/server.ts        (tool registration reads from spec)
       ├──▶ tests/tools/*.ts     (tests validate against spec)
       └──▶ CLAUDE.md            (this file documents the spec)

specs/schema.sql      ← Source of truth for database schema
       │
       ├──▶ docker-compose.yml          (init script)
       ├──▶ docker-compose.test.yml     (init script)
       └──▶ scripts/migrate.ts          (applies schema)
```

The web frontend, REST CRUD API, and entry-templates feature were removed in 2026-04 — Mitch edits via Obsidian, reads via MCP, logs via Telegram.

### Directory Map

```
src/
  index.ts          — Entry point. Stdio + HTTP transport setup.
  server.ts         — MCP server. Registers tools from spec.
  config.ts         — Env-aware config. Fails fast if DATABASE_URL missing in prod.
  db/
    client.ts       — PG Pool. Reads DATABASE_URL from config.
    embeddings.ts   — OpenAI embedding helper. Used by search tool at query time + embed script.
    queries/        — ALL SQL lives here. Domain-split modules, parameterized queries only.
      index.ts      — Re-exports all query modules (facade).
      entries.ts    — Entry search + read queries (Day One imports).
      artifacts.ts  — Artifact CRUD + search + graph queries.
      oura.ts       — Oura biometric data queries.
      chat.ts       — Chat message storage + retrieval.
      weights.ts    — Weight tracking queries.
      observability.ts — Activity logs.
      content-search.ts — Unified cross-type search.
      obsidian.ts   — Obsidian vault sync queries.
      usage.ts      — Universal usage_logs writer (logUsage helper).
      vault-fs.ts   — vault_fs_events writer (FS-event audit log, fed by fswatch).
      vocab-reviews.ts — Kindle-lookup vocab review FSRS state (queue/serve/rate).
      conjugations.ts — Read-only access to the vendored `conjugations` table.
      conjugation-reviews.ts — Lazy-promotion + race-safe rate for `(lemma, tense, person)` cells. Pattern selection (most-due / cold-start bootstrap), queue build, session counts.
      cloze-source.ts — Corpus lookup for cloze sentences. Curated sources only: vocab_reviews.examples → knowledge_artifacts.body (Tomos, References). Day One `entries.text` is excluded by design — those are Mitch's own Spanish and contain the very errors a drill is meant to correct. `looksSpanish` post-filter; `imperative_negative` anchors on `no <form>`.
  tools/
    search.ts       — Hybrid RRF search. The most important tool.
    get-entry.ts    — Single entry by UUID.
    get-entries-by-date.ts — Date range query.
    on-this-day.ts  — MM-DD across all years.
    find-similar.ts — Cosine similarity from a source entry.
    entry-stats.ts  — Writing frequency and trends.
    get-artifact.ts — Single artifact by ID with sources and version.
    list-artifacts.ts — List/filter artifacts by kind, pagination.
    search-artifacts.ts — Hybrid RRF search over knowledge artifacts.
    search-content.ts — Unified cross-type search over entries + artifacts.
    get-oura-summary.ts — Single-day Oura health snapshot.
    get-oura-weekly.ts — 7-day Oura overview with averages.
    get-oura-trends.ts — N-day trend analysis for a metric.
    get-oura-analysis.ts — Multi-type analysis: sleep quality, anomalies, HRV trend, temperature, best sleep.
    oura-compare-periods.ts — Side-by-side metrics comparison between two date ranges.
    oura-correlate.ts — Pearson correlation between two health metrics.
    sync-obsidian-vault.ts — Trigger Obsidian vault sync from R2.
    sync-oura.ts    — Trigger an Oura → Postgres sync. Mirrors `pnpm sync:oura`; takes a `lookback_days` parameter.
    get-obsidian-sync-status.ts — Obsidian vault sync status.
    write-vault-artifact.ts — Write a markdown file to the vault: R2 putObject + synchronous knowledge_artifacts upsert. Path whitelist (Pending/Insight/Review/Note/Project/Reference), frontmatter required, overwrite default false.
    log-weights.ts  — Upsert one or more daily body-weight measurements (single or batch).
    log-checkpoint.ts — Insert a Checkpoint Protocol toll into the `checkpoints` table; 10-min DB tuple dedup, accepts optional `kind`. `choice` defaults to `go` (substance kind: passes are mental, never logged — convention since 2026-05-13).
    distill-hn-thread.ts — Distill a Hacker News thread (article + full Algolia comment tree) and email + save to Pending/Reference.
    get-recent-checkpoints.ts — Last N days of checkpoints, oldest-first; used by Section B of the evening review prompt.
    get-recent-weights.ts — Last N days of weight measurements; thin wrapper over `listWeights`.
    get-oura-day-context.ts — Tags + meditation sessions + optimal-bedtime recommendation for a given day. Defaults to today.
    get-recent-agent-chats.ts — User-turn prompts from agent_sessions (Claude Code/Codex) + chat_messages (Telegram conversational flows). Excludes utility flows.
    get-recent-commits.ts — Public-repo GitHub REST fetch of recent commits to `mitchhankins01/espejo`. No auth. Only pushed commits show up.
  llm/              — Cross-provider abstraction over Vercel AI SDK + OpenAI SDK.
    chat.ts         — chat({provider, model, system, messages, tools, onTextDelta, cacheSystem}) wrapper around streamText.
    embed.ts        — embedText helper (OpenAI text-embedding-3-small).
    transcribe.ts   — Whisper wrapper.
    vision.ts       — Image / PDF text extraction.
    tts.ts          — OpenAI TTS (synthesizeSpeech).
    cloze-gen.ts    — Haiku one-shot cloze sentence generator. Only fires on corpus-miss for /conj; output is cached on `conjugation_reviews.generated_sentence`.
    index.ts        — Re-exports.
  fsrs/
    scheduler.ts    — Thin ts-fsrs wrapper. CardState ↔ FsrsCard adapters and `nextState(card, grade)`.
    conj-grading.ts — Pure typed-conjugation grader (case-insensitive, whitespace-normalized, accent-sensitive). `-ra`/`-se` equivalence for imperfecto / pluscuamperfecto subjuntivo.
    gloss.ts        — Haiku gloss-fill batched for vocab_reviews enrichment.
  telegram/
    webhook.ts      — Telegram webhook handler. Validates secret token, hands updates to router.
    updates.ts      — Update deduplication, per-chat queue, fragment reassembly.
    router.ts       — Tiered routing: Tier 1 media classifiers (screen-time, weight CSV) → Tier 2 extraction (voice/photo/doc → text) → Tier 3 dispatch (registered slashes, active flow, solo HN URL, default chat).
    flow-state.ts   — Typed Map<chatId, FlowState> for in-memory per-chat flow state. Lost on restart by design.
    flows/
      checkpoint.ts — 2-step Checkpoint Protocol state machine (`/checkpoint` and `/c` aliases) + 1 Haiku mirror call at exit. Inserts into `checkpoints` table; substance resolution defaults to `go` (per 2026-05-13 convention — passes are handled mentally, never logged).
      distill-hn.ts — Solo HN URL → distill_hn_thread tool. ~70 LOC.
      weight-slash.ts — /weight value [today|yesterday|YYYY-MM-DD|last monday|N days ago] → log_weights.
      weight-csv.ts — Tier-1 RENPHO CSV pre-router → log_weights batch.
      practice.ts   — /practice + /done Spanish coach. Calls llm/chat() directly; extraction handled by practice-session.ts.
      vault-prompt.ts — /hilo /evening generic vault-prompt runner. Loads body from knowledge_artifacts (R2 fallback), strips frontmatter, runs chat() with full read tools + write_vault_artifact.
      chat.ts       — Default fallback. Anthropic Sonnet, 12-msg context cap (flow IS NULL OR flow='chat'), full read tools + write_vault_artifact, streams via chat() + createStreamEditor, prompt caching enabled.
      conj.ts       — /conj typed Spanish conjugation drill. One pattern per session, FSRS-scheduled per (lemma, tense, person) cell. `/hint` and `/easy` are sub-commands of the conj flow (not globally registered). Cloze sentences come from curated sources only — vocab_reviews.examples first, then knowledge_artifacts.body — falling back to Haiku one-shot cached on the row. **`entries.text` (Day One journal) is deliberately excluded**: it contains Mitch's own Spanish slips, and using it as the model would test him against his own mistakes.
      tool-catalog.ts — Builds the AI-SDK ToolSet from spec handlers for chat + vault-prompt flows.
    truncation.ts   — Tool-result truncation for chat_messages persistence.
    practice-session.ts — Practice extraction (Claude call → JSON → R2 + DB upsert of Español Vivo).
    client.ts       — Telegram Bot API client. sendMessage/sendVoice, retry, chunking, streaming editor.
    voice.ts        — Voice transcription (Whisper). Synthesis path removed.
    media.ts        — Photo/document processing: vision, text/PDF extraction.
    network-errors.ts — Recoverable network error classification for retry logic.
    conj-hints.ts   — Pure pattern-hint builder for `/conj /hint`. 33 templates, never leaks expected_form.
  oura/
    client.ts       — Oura API v2 client.
    sync.ts         — Oura sync engine: API fetch + DB upserts + advisory lock + timer.
    context.ts      — Oura context prompt builder for Telegram agent injection.
    formatters.ts   — Oura tool response formatting helpers.
    analysis/       — Statistical analysis, split from monolithic analysis.ts.
      index.ts      — Re-exports all analysis modules (facade).
      statistics.ts — Core stats: mean, stddev, percentiles, linear regression.
      trends.ts     — Trend detection, rolling averages, day-of-week patterns.
      outliers.ts   — Outlier detection (IQR + Z-score).
      correlations.ts — Pearson correlation, metric pairing.
      sleep.ts      — Sleep debt, regularity, stage ratios, best conditions.
      hrv.ts        — HRV recovery patterns, rolling averages.
    types.ts        — TypeScript interfaces for stored Oura data.
  obsidian/
    sync.ts         — Obsidian vault sync engine: R2 fetch + DB upserts + timer. Tripwire: notifyAlert when a non-conflict canonical soft-deletes.
    parser.ts       — Markdown frontmatter parser for Obsidian notes.
    wiki-links.ts   — Wiki-link parsing and resolution.
    fs-event-parsers.ts — fswatch / eslogger event-line parsers for the vault-fs-watcher script.
  notifications/
    on-this-day.ts  — "On This Day" morning reflection notification.
  utils/
    dates.ts        — Shared timezone-aware date utility (todayInTimezone).
  transports/
    http.ts         — Express HTTP bootstrap. Mounts MCP, OAuth, health, Telegram webhook.
    oauth.ts        — OAuth token validation for HTTP API authentication.
    routes/
      health.ts     — Health check endpoint.
  storage/
    r2.ts           — Cloudflare R2 client. Upload, exists check, public URL.
  formatters/
    entry.ts        — Raw DB row → human-readable string with emoji, metadata, media URLs.
    search-results.ts — Ranked results with RRF score context.
scripts/
  sync-dayone.ts    — DayOne.sqlite → PG. Idempotent (ON CONFLICT DO UPDATE).
  sync-obsidian.ts  — Trigger R2 → DB Obsidian sync on demand against prod (pnpm sync:obsidian). Callable by LLMs after vault edits.
  sync-oura.ts      — Backfill/sync Oura biometrics into Postgres (pnpm sync:oura).
  sync-weight.ts    — Sync weight data to production.
  embed-entries.ts  — Batch embed all entries missing embeddings.
  ingest-sessions.ts — Ingest Claude Code / OpenCode / Codex session metadata into agent_sessions (pnpm ingest:sessions). See specs/agent-sessions-ingestor.md.
  ingest-activity.ts — Ingest ActivityWatch events into device_events, atuin shell history into usage_logs, Screenpipe OCR/audio chunks into screen_captures (pnpm ingest:activity). Args: --dry-run, --force, --since, --source <aw|atuin|screenpipe>, --skip-if-fresh 24h. See specs/2026-05-03-activity-capture-plan.md.
  backfill-checkpoints.ts — One-time: parse Artifacts/Checkpoint/*.md from R2 into the `checkpoints` table. Idempotent via the dedup unique index. Default --dry-run; require --apply to mutate.
  import-lookups.ts — Bulk import Spanish verbs + Kindle lookups.
  import-conjugations.ts — One-shot import of `data/conjugations-es/verbs.json` + `data/verb-frequency-es.txt` into the `conjugations` table. Idempotent (`ON CONFLICT (lemma,tense,person) DO UPDATE`). Run as `pnpm import:conjugations`.
  lib/
    pattern-classifier.ts — Pure: `(lemma, tense, person, form) → one of 33 conjugation pattern buckets`. Person-scoped rules (e.g. yo-go separate from stem-changing tu/el/ellos) + small hardcoded irregular sets.
  write-tomo.ts     — Write the next Espejo tomo. Two-step flow: `--plan-only` emits 6 candidates (3 essay + 3 flow) saved to `books/next-plan.json`; `--pick=<1-6>` runs the writer with the chosen candidate. Flags: `--steer "..."`, `--bilingual` / `--no-bilingual`, `--share-julia` / `--no-share-julia`, `--fresh-plan`. See `Artifacts/Prompt/Spanish/Tomo.md`.
  condense-insights.ts — Periodic condensation pass over insights.
  migrate.ts        — Runs SQL files, tracks applied migrations in _migrations table.
  migrate-entries-to-artifacts.ts — One-time migration of entries into knowledge artifacts.
  migrate-llm-entries.ts — One-time migration for LLM-generated entries.
  cleanup-llm-entries.ts — One-time cleanup for LLM-generated entries.
  backfill-artifact-timestamps.ts — One-time backfill for artifact created_at/updated_at.
  deploy-smoke.ts   — Post-deploy smoke test.
  telegram-setup.ts — Set/check/delete Telegram webhook.
  spec-plan.sh      — Wraps the planning workflow.
  vault-fs-watcher.ts — Stdin reader → vault_fs_events. Parses fswatch (`-x`) lines or eslogger JSON, batches inserts. Run by the launchd agent in scripts/vault-fs/.
  vault-fs/         — Launchd plists + wrapper scripts for the FS-event watchers (fswatch deployed; eslogger archived as Sequoia TCC dead-end).
  dedup/
    retrieve.ts     — Stage 1: hybrid RRF over Insight ∪ Pending, emits dedup-plan.json (pnpm dedup:retrieve).
    council.mjs     — Stage 2: fans out Claude/Gemini/GPT in parallel, chunks GPT, validates JSON (pnpm dedup:council).
    synthesize.mjs  — Stage 3: tallies leg outputs, picks recommended merge bodies, writes synthesis.json + preview.md (pnpm dedup:synth).
    apply.mjs       — Stage 4: snapshot + inbound-wikilink rewrite + execute. Dry-run default; --apply to mutate (pnpm dedup:apply).
    check-faithfulness.mjs — Optional: per-sentence cosine sim check that LLM merge bodies trace back to source/target content (pnpm dedup:check).
specs/
  schema.sql        — Canonical DB schema.
  tools.spec.ts     — Tool contracts: params, types, descriptions, examples.
  — Implemented:
  agent-sessions-ingestor.md, telegram-chatbot-plan.md, telegram-personality-plan.md,
  self-healing-organism.md, 2026-05-04-telegram-refactor-plan.md,
  oura-integration-plan.md, knowledge-artifacts.md, insights-dedup-rewrite.md,
  insight-engine.md
  — Removed Features (specs kept for history; feature was removed in 2026-04):
  web-app.spec.md, web-quick-switcher.md, web-semantic-links.md, web-graph-view.md,
  web-feature-rollout.md, web-journaling.md, web-db-observability.md,
  web-weight-tracking.md
  — Research: ltm-research.md, refactor.md
  — Planned/Stub: aws-sst-migration-plan.md, chat-archive.md, project-management.md
  fixtures/
    seed.ts         — Test data with pre-computed embeddings for determinism.
data/
  conjugations-es/  — Vendored verbecc-derived Spanish conjugation cells (LGPL-3.0). `verbs.json` is the flat raw form/lemma/tense/person/template list consumed by `scripts/import-conjugations.ts`.
  verb-frequency-es.txt — Hermit Dave FrequencyWords Spanish list (CC-BY-SA-4.0). Lemma rank seeds `conjugations.frequency_rank` and promotion ordering for /conj.
  LICENSE-frequency-words.txt — Attribution + CC-BY-SA license preserved alongside the frequency list.
docs/               — Deep documentation (see Deep Docs section below).
```

## Key Patterns

### All SQL in queries/

Every database query is a function in `src/db/queries/`. Tools call these functions — they never write SQL directly. Queries use parameterized placeholders (`$1`, `$2`), never string interpolation.

```typescript
// CORRECT
export async function getEntryByUuid(pool: Pool, uuid: string) {
  const result = await pool.query('SELECT * FROM entries WHERE uuid = $1', [uuid]);
  return result.rows[0];
}

// WRONG — never do this
const result = await pool.query(`SELECT * FROM entries WHERE uuid = '${uuid}'`);
```

### RRF Search Implementation

The hybrid search in `search_entries` runs two parallel retrievals and merges with RRF:

1. **Semantic**: Embed the query string via OpenAI → cosine similarity search via pgvector (`<=>` operator)
2. **BM25**: Full-text search via tsvector (`@@` operator with `ts_rank`)
3. **Merge**: RRF with k=60 — `score = 1/(60 + rank_semantic) + 1/(60 + rank_bm25)`

Both retrievals pull top-20 candidates. The merge produces the final ranked list. Optional filters (date range, city) are applied as WHERE clauses in BOTH retrievals to keep results consistent.

The query must embed the search string at runtime using the same model used for indexing (`text-embedding-3-small`).

### Config Fails Fast

`src/config.ts` throws on startup if `DATABASE_URL` is empty in production. Don't let the server start and fail on first query — that's harder to debug.

### Formatters Are the Presentation Layer

Tools return raw data from queries. Formatters turn DB rows into human-readable MCP responses. A formatted entry looks like:

```
📅 November 15, 2025 — Barcelona, Spain
🏷️ morning-review, nicotine

Woke up feeling depleted. The nicotine yesterday definitely crashed
my dopamine baseline...

---
☁️ Partly Cloudy, 18°C | 📍 Eixample
```

Keep formatters pure functions with no side effects.


### Sync Is Idempotent

`scripts/sync-dayone.ts` reads directly from the DayOne.sqlite database and uses `ON CONFLICT (uuid) DO UPDATE` so re-running it updates existing entries. Run `pnpm sync` any time to pick up new or modified entries from Day One.

Media files (photos, videos, audio) are uploaded to Cloudflare R2 during sync if R2 credentials are configured. The sync checks if each file already exists in R2 (HEAD request) and skips re-upload. Use `--skip-media` for a quick metadata-only sync. Attachments with `ZHASDATA=0` (iCloud-only, not downloaded locally) are skipped with a warning.

## Adding a New Tool

1. Add the tool spec to `specs/tools.spec.ts` — define name, description, params, types
2. Write a failing test in `tests/tools/<tool-name>.test.ts`
3. Add the SQL query to the appropriate domain module in `src/db/queries/`
4. Write a formatter in `src/formatters/` if the tool needs custom output formatting
5. Implement the tool in `src/tools/<tool-name>.ts`
6. Register it in `src/server.ts`
7. Run `pnpm check` — everything must pass
8. Update this file's tool list if needed

## Main Branch Release Protocol

Any time you commit and push directly to `main`, follow this order:

1. Run local validation:
   ```bash
   pnpm check
   ```
2. Run production migration **before** pushing:
   ```bash
   NODE_ENV=production DATABASE_URL=<railway_url> pnpm migrate
   ```
3. Push `main`. Capture the SHA: `SHA=$(git rev-parse HEAD)`.
4. Watch Railway deployment to completion. Match by **commit SHA**, not by log timestamps:
   ```bash
   # Poll until the latest deployment matches the pushed SHA and reaches a terminal state.
   # Statuses: SUCCESS | FAILED | CRASHED | REMOVED | BUILDING | DEPLOYING | INITIALIZING | QUEUED
   until out=$(railway deployment list --json --limit 1 2>/dev/null) \
     && [ "$(jq -r '.[0].meta.commitHash' <<<"$out")" = "$SHA" ] \
     && jq -e '.[0].status | IN("SUCCESS","FAILED","CRASHED")' <<<"$out" >/dev/null; do
     sleep 10
   done
   jq -r '.[0] | "\(.status) \(.id) commit=\(.meta.commitHash[0:7])"' <<<"$out"
   ```
   On `SUCCESS`, hit `/health` to confirm: `curl -s https://espejo-production.up.railway.app/health`.
   On `FAILED` / `CRASHED`, pull build + deploy logs for that exact deployment ID:
   ```bash
   railway logs --build <id> --lines 200
   railway logs --deployment <id> --lines 200
   ```

   Why match on SHA: `railway logs --deployment` (no ID) streams the *currently active* container, which until cutover is still the *previous* deploy. Comparing log-line timestamps against `date -u` is brittle (already-booted prior deploys look "recent"). The deployment list is the canonical state: each row carries `meta.commitHash` and a `status` field, so SHA equality + terminal status is unambiguous.

## Code Style

- TypeScript strict mode — no `any` unless absolutely necessary (and add a comment explaining why)
- All functions have explicit return types
- Use `zod` for runtime validation of tool input params
- Prefer `const` over `let`, never use `var`
- Use early returns over nested conditionals
- Error messages should be actionable — say what went wrong AND what to do about it
- No `console.log` in `src/` — use structured logging or MCP SDK's logging if needed
- `console.log` is fine in `scripts/` for progress output
- Before bulk CRUD on the vault or DB artifacts, show a diff/preview and wait for confirmation
- `commit and push` is terminal — execute, don't re-confirm or add gold-plating
- Prefer embedding/tsvector for cost-sensitive loops (dedup, matching) — don't LLM every comparison
- Don't build CLI wrappers for things that can be a prompt or skill (YAGNI)

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server + transport |
| `pg` | PostgreSQL client |
| `pgvector` | pgvector type support for node-postgres |
| `openai` | Embedding generation |
| `zod` | Runtime param validation |
| `dotenv` | Env file loading |
| `express` | HTTP server for Telegram webhook + MCP StreamableHTTP transport |
| `@aws-sdk/client-s3` | Cloudflare R2 media storage (S3-compatible) |
| `better-sqlite3` | Read DayOne.sqlite during sync |
| `@anthropic-ai/sdk` | Claude agent for Telegram chatbot conversations |

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Write/update/delete MCP tools for journal entries — Day One is the canonical writer for `entries`; new long-form notes go into the Obsidian vault and flow through the artifact sync.
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)
- Auto-purge of compacted messages (function exists in `queries.ts`, not wired up)

See `specs/*.md` files marked `[Stub]` or `[Planned]` for upcoming features.

## Obsidian Vault Workflows

`Artifacts/` is a symlink to `~/Documents/Artifacts` — Mitch's Obsidian vault (gitignored). Syncs bidirectionally with Postgres via Cloudflare R2 (Remotely Save plugin → R2 → `src/obsidian/sync.ts`).

**Important:** most Claude Code sessions and all OpenCode sessions for espejo operate on the **vault + prod DB**, not on `src/`. Treat these as first-class, not edge cases. Distinguish from the DB-backed `knowledge_artifacts` table in `src/db/queries/artifacts.ts` — the vault is plain markdown on disk; the DB is the synced downstream index.

### Vault folders

```
Artifacts/
  Insight/     — atomic realizations (canonical home for approved insights)
  Journal/     — entries migrated from Day One
  Review/      — structured reflections (evening/weekly/monthly)
  Note/        — general knowledge notes
  Project/     — maps-of-content linking related notes
  Reference/   — external references
  Prompt/      — reusable prompts + user-defined slash commands
  Parts/       — IFS parts work (parts.md is a CONCISE OVERVIEW — preserve hierarchy)
  Attachment/  — media
  Template/    — Obsidian templates (NOT synced)
  Pending/     — extracted insights awaiting dedup approval (written by `Artifacts/Prompt/Insights/Extract.md`)
```

Any `.md` outside `.obsidian/`, `.trash/`, `Template/` syncs to the DB.

### Frontmatter schema

```yaml
---
kind: insight | reference | note | project | review
status: pending | approved    # default: approved
tags:
  - lowercase-hyphenated
---
```

- **Filename is the title.** Don't add an `# H1` heading inside the file — Obsidian renders the filename as the title, so an H1 produces a duplicated title in the UI. Sync (`src/obsidian/parser.ts:66`) falls back to the filename when no H1 exists, so dropping it is safe and correct.
- Title is NEVER in frontmatter either. Just the filename.
- Body starts immediately on the line after the closing `---`. No blank line.
- `[[Wiki Links]]` become graph edges in the DB.
- `status: pending` = excluded from semantic search until approved.
- Tags are normalized to lowercase on sync.

### Reusable prompts (Artifacts/Prompt/)

`Artifacts/Prompt/` is the canonical home for cross-tool reusable prompts. Mitch invokes them by referring to the file in plain text — *"Run Artifacts/Prompt/Insights/Dedup.md"* — not as slash commands. When you see that pattern, read the matching file and execute it; don't regenerate.

Current inventory:

| file | purpose |
|---|---|
| `Review/Evening.md` | End-of-day review prompt — closes the loop on the day's pulls/decisions. |
| `Review/Weekly.md` | Weekly pattern-interrupt review (writes Review-kind artifacts). |
| `Review/Monthly.md` | Monthly Proyecto Mitch review (writes Review-kind artifacts). |
| `Insights/Extract.md` | Per-Review atomic insight extraction → `Pending/`. Mitch supplies the Review filename. Retrieval is for terminology/wikilinks only; dedup decisions live in `Insights/Dedup.md`. |
| `Insights/Dedup.md` | Stage-1-through-4 dedup pipeline orchestrator. References `scripts/dedup/`. |
| `Insights/Condense.md` | Periodic condensation of related insights into thematic clusters. |
| `Therapy/Prep.md` | Pre-therapy load + session-prep prompt. |
| `Therapy/Processing.md` | Distill a therapy session transcript into `Artifacts/Review/YYYY-MM-DD — Therapy.md`. |
| `Therapy/Parts Check-in.md` | IFS midday parts check-in protocol. |
| `Therapy/Checkpoint.md` | Body-meeting / Checkpoint Protocol (3-turn). |
| `Spanish/Tomo.md` | Generate the next Tomo (Phase 0 imports Kindle lookups). |
| `Spanish/Vivo.md` | Update `Artifacts/Project/Español Vivo.md` from recent ingestion. |
| `Spanish/Hilo.md` | Spanish thread / tutor prompt. |
| `Council Review.md` | Multi-model deliberation wrapper used by `Insights/Dedup.md` and other workflows. |

### SOP: Pending → Insight dedup

1. Glob `Artifacts/Pending/*.md` and `Artifacts/Insight/*.md`.
2. For each pending, classify vs. existing using **embedding similarity + tsvector** (hybrid RRF, same as `search_entries`). Don't LLM-compare — it gets expensive at scale.
3. Label each **New / Duplicate / Merge** and show candidates.
4. **Ask before acting.** Never move/merge/delete without explicit confirmation.
5. On approval: `status: pending` → `approved`, optionally relocate out of `Pending/`, let Remotely Save → R2 → sync pick it up.
6. To reject: delete the file.

Scope rules **by `kind`** — `insight`-only logic should not apply to `review`/`note`.

### SOP: Load context on topic/person

"Pull in X" = hybrid RRF over DB (entries + artifacts) **plus** `Glob`/`Grep` under `Artifacts/`, with **max limits + request more if available**. MCP tools have implicit limits and under-retrieve — be explicit.

### SOP: Run a checkin prompt

Evening review, morning prompt, midday parts checkin, tolls: read from `Artifacts/Prompt/`, execute against current DB + vault state. Dates derive from source wikilink filenames — never hardcode.

### Direct DB + filesystem > MCP (for vault-side prompt work)

MCP tools have hardcoded limits and sometimes hardcoded dates. For prompt execution prefer direct access:

```bash
PGURL=$(grep ^DATABASE_URL .env.production.local | cut -d= -f2-)
OPENAI_API_KEY=$(grep ^OPENAI_API_KEY .env.production.local | cut -d= -f2-)
PSQL=/opt/homebrew/opt/libpq/bin/psql   # libpq Homebrew formula, not on PATH
```

Then `$PSQL "$PGURL"` + OpenAI embeddings API (`text-embedding-3-small` — same model as indexing).

### Vault ↔ DB sync

- Vault → R2: Remotely Save auto-syncs on edit.
- R2 → DB: `sync_obsidian_vault` MCP tool, the timer in `src/obsidian/sync.ts`, or `pnpm sync:obsidian` (production, on-demand — preferred for LLM sessions that just edited the vault and want to land changes in DB without waiting for the timer).
- Status: `get_obsidian_sync_status` MCP tool.

### Writing notes — don'ts

- No frontmatter-less files (they sync as `kind: note` with no tags).
- No `status: active` — only `pending` / `approved`.
- No content above frontmatter.
- No duplicate title in both frontmatter and heading.
- No H1 inside the file. Filename = title. Adding `# Title` after the frontmatter renders twice in Obsidian.
- `parts.md` stays a concise OVERVIEW — don't inline part bodies.

## Gotchas

- **Oura `day_summary` lags 1 day.** For today's signal use `recovery`/`stress` second-level data, not `day_summary`.
- **Ports**: dev PG `5434`, test PG `5433` (5432 is claimed by the greenline project).
- **Zod rejects `null` for optional date strings** — see `specs/2026-04-09-fix-mcp-null-optional-params-plan.md` before adding new optional-date params.
- **DayOne sync**: null-byte/backslash handling required on text fields; `ZHASDATA=0` attachments are iCloud-only and must be skipped.
- **Agent tool-call audit**: every Telegram agent run inserts a row in `activity_logs` with `tool_calls` JSONB containing `{name, args, result}` for each tool call. To inspect a recent agent action: `SELECT created_at, jsonb_pretty(tool_calls) FROM activity_logs WHERE tool_calls::text LIKE '%<tool_name>%' ORDER BY created_at DESC LIMIT 5;` — canonical way to see what arguments the agent passed without re-running anything.
- **Universal usage log**: `usage_logs` records every MCP tool call (including from Claude desktop/mobile, which `activity_logs` does not capture), every HTTP request (excluding `/health`), Telegram tool dispatch (mirrors the per-tool slice of `activity_logs`), and cron fires (oura-sync, obsidian-sync, on-this-day). Schema: `(ts, source, surface, actor, action, args jsonb, ok, error, duration_ms, meta jsonb)`. Examples:
  - "Which MCP tools fired in the last 24h": `SELECT action, surface, COUNT(*) FROM usage_logs WHERE source = 'mcp' AND ts > NOW() - INTERVAL '1 day' GROUP BY 1,2 ORDER BY 3 DESC;`
  - "Did anything error today": `SELECT ts, source, action, error FROM usage_logs WHERE NOT ok AND ts > NOW() - INTERVAL '1 day' ORDER BY ts DESC;`
  - Use this table for traffic/source breakdowns; keep `activity_logs` for full-conversation Telegram audits (memories, cost, complete tool transcript).
- **`daily_metrics` upsert preserves `created_at`**: the `ON CONFLICT (date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg` clause only touches `weight_kg`, so `created_at` reflects the original insert. Use `activity_logs` (not `daily_metrics.created_at`) to determine when a value was last written.
- **Chat logs** (useful when Mitch asks "what did I do last week"):
  - Claude Code sessions: `~/.claude/projects/-Users-mitch-Projects-espejo/*.jsonl`
  - Claude Code prompt history: `~/.claude/history.jsonl` (filter by `project`)
  - OpenCode DB: `~/.local/share/opencode/opencode.db` (tables: `session`, `message`, `part`)
  - OpenCode prompt history: `~/.local/state/opencode/prompt-history.jsonl`
- **Slash commands need a session restart.** New `.claude/commands/*.md` files don't register until Claude Code reloads — `/name` returns "Unknown command" until then. Same for edits to existing command files (the body is read at registration time).
- **`CLAUDE.md` is a symlink to `AGENTS.md`.** Edits to "CLAUDE.md" land in AGENTS.md and that's where `git diff` shows them. Edit AGENTS.md directly to avoid confusion.
- **Vault FS forensics** (when Mitch asks "what happened with X.md" or reports a missing canonical / new ` 2.md` conflict copy): query in this order: (1) `obsidian_sync_runs.deleted_paths` — exact paths each R2→DB tick soft-deleted; (2) `vault_fs_events` (fed by an fswatch LaunchAgent on Mitch's Mac) for local FS create/unlink/modify/rename timing under `~/Documents/Artifacts`. The `process_name`/`pid`/`ppid` columns exist but stay null — eslogger-based attribution was abandoned (Sequoia TCC dead-end; see `scripts/vault-fs/README.md`). Bodies of soft-deleted artifacts remain in `knowledge_artifacts.body` for recovery; the Telegram tripwire in `src/obsidian/sync.ts` fires `notifyAlert` on canonical loss.
- **`conjugations` is read-only post-import**. Rebuild via `pnpm import:conjugations` — idempotent (`ON CONFLICT (lemma,tense,person) DO UPDATE`). Refresh frequency-rank ordering after updating `data/verb-frequency-es.txt` by re-running the same script. The runtime flow only writes to `conjugation_reviews` / `conjugation_review_log`. `/conj` is the only entry point — `/hint` and `/easy` are sub-commands of the conj flow (not globally registered slashes).

## Deep Docs

- [Testing](docs/testing.md) — test tiers, isolation, fixtures, coverage, assertions
- [Development](docs/development.md) — environments, common tasks, DB access
