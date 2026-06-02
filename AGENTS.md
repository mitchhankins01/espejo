# espejo-mcp

MCP server + Telegram chatbot for semantic journal search over Day One exports in PostgreSQL + pgvector.

## Session Init — Run This First

**Scope: interactive multi-turn working sessions only.** Skip this block if you're invoked as a one-shot tool (`codex exec`, `claude -p` headless, library/script call, dedup-council leg, etc.) — the host process owns ingestion, not the inner call. Running these from a non-interactive inner invocation burns the model's budget on bootstrap before reaching the actual task (observed 2026-05-28: Codex `exec` in `scripts/dedup/council.mjs` hit a 600s timeout running these; the fix is to invoke the inner Codex with `-s read-only` so it cannot try to bootstrap).

When you (Claude Code, OpenCode, Codex, or any other agent) start an interactive multi-turn session in this directory, run:

```bash
pnpm ingest:sessions --skip-if-fresh 24h
pnpm ingest:activity --skip-if-fresh 24h
```

Both are no-ops if a successful run completed in the last 24 hours. Otherwise they capture:
- Claude Code / OpenCode / Codex session logs → `agent_sessions` table (see `specs/agent-sessions-ingestor.md`).
- ActivityWatch window/web/afk events → `device_events` table (see `specs/2026-05-03-activity-capture-plan.md`, Phase 2). No-ops cleanly when ActivityWatch isn't installed.
- Atuin shell history → `usage_logs` (`source='shell'`) (see plan, Phase 3). No-ops cleanly when atuin isn't installed.
- Screenpipe OCR chunks → `screen_captures` (see plan, Phase 4). Audio capture disabled because macOS Sequoia + launchd can't deliver the runtime Microphone perm prompt the binary needs (Screen Recording allows manual `+`-add; Microphone does not). No-ops cleanly when Screenpipe isn't installed.

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

## Obsidian Vault Workflows

`Artifacts/` is a symlink to `~/Documents/Artifacts` — Mitch's Obsidian vault (gitignored). Syncs bidirectionally with Postgres via Cloudflare R2 (Remotely Save plugin → R2 → `src/obsidian/sync.ts`).

**Important:** most Claude Code sessions and all OpenCode sessions for espejo operate on the **vault + prod DB**, not on `src/`. Treat these as first-class, not edge cases. Distinguish from the DB-backed `knowledge_artifacts` table in `src/db/queries/artifacts.ts` — the vault is plain markdown on disk; the DB is the synced downstream index.

### Vault folders

```
Artifacts/
  Insight/     — atomic realizations about Mitch's lived experience (canonical home for approved insights — the "Me graph")
  Tenet/       — external claims endorsed as true-and-important (canonical home for approved tenets — the "world graph"; parallel to Insight/, sourced from References/HN distills via `Artifacts/Prompt/Tenets/Curate.md`)
  Journal/     — entries migrated from Day One
  Review/      — structured reflections (evening/weekly/monthly)
  Note/        — general knowledge notes. Includes `Parts.md` — the concise IFS
                 parts roster (preserve hierarchy, don't inline part bodies;
                 check this before naming a "new" part).
  Project/     — maps-of-content linking related notes
  Reference/   — external references (Academic/ subfolder = fetched
                 research papers from Madriguera, one file per paper,
                 deduped by DOI; interim store for a future
                 research_papers embedding table)
  Prompt/      — reusable prompts + user-defined slash commands
  Attachment/  — media
  Template/    — Obsidian templates (NOT synced)
  Pending/     — extracted artifacts awaiting dedup approval. Top-level `Pending/*.md` = insights
                 (written by Insights/Curate.md). `Pending/Tenet/*.md` = tenets (written by
                 Tenets/Curate.md). `Pending/Reference/HN-*.md` = HN distills (written by
                 the distill_hn_thread Telegram tool).
  Checkpoint/  — markdown mirrors of `checkpoints` table rows (one file per toll; backfill-only origin)
```

Any `.md` outside `.obsidian/`, `.trash/`, `Template/` syncs to the DB.

### Frontmatter schema

```yaml
---
kind: insight | reference | note | project | review | tenet
status: pending | approved    # default: approved
tags:
  - lowercase-hyphenated
---
```

- **Filename is the title.** Don't add an `# H1` heading inside the file — Obsidian renders the filename as the title, so an H1 produces a duplicated title in the UI. Sync falls back to the filename when no H1 exists, so dropping it is safe and correct.
- Title is NEVER in frontmatter either. Just the filename.
- Body starts immediately on the line after the closing `---`. No blank line.
- `[[Wiki Links]]` become graph edges in the DB.
- `status: pending` = excluded from semantic search until approved.
- Tags are normalized to lowercase on sync.

### Reusable prompts (Artifacts/Prompt/)

`Artifacts/Prompt/` is the canonical home for cross-tool reusable prompts. Mitch invokes them by referring to the file in plain text — *"Run Artifacts/Prompt/Insights/Dedup.md"* — not as slash commands. When you see that pattern, read the matching file and execute it; don't regenerate.

For the live inventory: `find Artifacts/Prompt -name '*.md'`. The major prompts:

| file | purpose |
|---|---|
| `Audit.md` | Surface drift between AGENTS.md / code / vault state and propose surgical fixes. |
| `Review/Evening.md` | End-of-day review prompt — closes the loop on the day's pulls/decisions. |
| `Review/Weekly.md` | Weekly pattern-interrupt review (writes Review-kind artifacts). |
| `Review/Monthly.md` | Monthly Proyecto Mitch review (writes Review-kind artifacts). |
| `Insights/Curate.md` | **Unified Review→Insight pipeline** — extract → bridge → dedup → apply in one prompt. Primary daily flow for familiar themes. |
| `Insights/Extract.md` | Per-Review atomic insight extraction → `Pending/`. Mitch supplies the Review filename. Use for novel conceptual domains where Curate's batched themes return zero palette hits. |
| `Tenets/Curate.md` | **Unified Reference→Tenet pipeline** — mirror of `Insights/Curate.md` over the "world graph". Extracts atomic tenets (external claims, endorsed-not-just-used) from HN distills in `Pending/Reference/` into `Pending/Tenet/`, then bridge → council → apply into `Tenet/`. Cross-links to Insights via wikilinks; the two graphs stay distinct in v1. Requires the dedup-script `--kind tenet` PREREQUISITE noted inside the prompt. |
| `Insights/Dedup.md` | Stage-1-through-4 dedup pipeline orchestrator. References `scripts/dedup/`. |
| `Insights/Condense.md` | Periodic condensation of related insights into thematic clusters. |
| `Sync Conflicts.md` | Cleanup pass over Remotely Save ` 2.md` conflict copies. Snapshots canonicals before bulk-rm and re-verifies after a 60s sleep — Remotely Save can drift the canonical post-cleanup. |
| `Therapy/Prep.md` | Pre-therapy load + session-prep prompt. |
| `Therapy/Processing.md` | Distill a therapy session transcript into `Artifacts/Review/YYYY-MM-DD — Therapy.md`. |
| `Therapy/Parts Check-in.md` | IFS midday parts check-in protocol. |
| `Therapy/Checkpoint.md` | Body-meeting / Checkpoint Protocol (3-turn). |
| `Spanish/Tomo.md` | Generate the next Tomo (Phase 0 imports Kindle lookups). |
| `Spanish/Hilo.md` | Spanish thread / tutor prompt. |
| `Madriguera.md` | Research rabbit-hole: AI interviews Mitch on a curiosity while pulling live papers from OpenAlex + Europe PMC. CLI-only. Every fetched paper is persisted to `Reference/Academic/` (one file per paper, deduped by DOI) as the interim store for a future `research_papers` embedding table. |
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
- `Note/Parts.md` stays a concise OVERVIEW — don't inline part bodies.

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

### Repo skeleton

The directory map below is intentionally shallow. For exact files use `ls` / `Glob`; for current registered MCP tools read `src/server.ts`; for current package deps read `package.json`; for live vault prompts run `find Artifacts/Prompt -name '*.md'`. Don't trust this map for fine-grained inventory — it's an entry map.

```
src/
  index.ts, server.ts, config.ts       — Entry, MCP wiring, env-aware config (fails fast on missing DATABASE_URL in prod).
  db/queries/                          — ALL SQL lives here. Domain-split, parameterized only. Tools never write SQL.
  tools/                               — MCP tool implementations. One file per tool; specs in `specs/tools.spec.ts`.
  llm/                                 — Cross-provider chat / embed / transcribe / vision / tts (Vercel AI SDK + OpenAI).
  fsrs/                                — ts-fsrs scheduler + Spanish-specific graders + Haiku gloss-fill.
  telegram/                            — Webhook, router (tiered: media classifier → extraction → dispatch), per-chat flows (chat, vault-prompt, conj, practice, checkpoint, weight, distill-hn). Flow state is in-memory; lost on restart by design. `keyboard.ts` = persistent reply keyboard (🎯 Checkpoint · 🧠 SRS · 🔤 Conj); a tap arrives as the exact emoji label and the router rewrites it to the matching slash. Pinned via the chat-flow seed message (reply keyboards ride sendMessage, persist across edits, and coexist with srs/conj inline keyboards).
  oura/                                — Oura v2 client + sync + analysis/ (statistics, trends, outliers, correlations, sleep, hrv).
  obsidian/                            — R2→DB vault sync (with tripwire on canonical loss), frontmatter parser, wiki-link resolver, FS-event parsers.
  ingest/                              — One-shot ingestors: claude-code, opencode, codex, activitywatch, atuin, screenpipe.
  hn/                                  — Hacker News distillation pipeline (Algolia + article fetch + email + vault save).
  email/                               — Nodemailer wrapper.
  prompts/                             — In-code prompt strings (Spanish practice extractor, etc.).
  formatters/                          — DB row → human-readable string. Pure functions.
  transports/                          — Express HTTP + OAuth + /health.
  storage/                             — Cloudflare R2 client.
  utils/                               — Shared helpers (timezone-aware date utility, etc.).
scripts/
  sync-*.ts, ingest-*.ts               — On-demand and periodic syncs / ingestors.
  gather-evening.ts                    — Evening-review data gatherer (`pnpm gather:evening`). Reads DB + vault + Mac WhatsApp into one digest at `/tmp/espejo-evening-gather/<date>.md`; the deterministic half of `Artifacts/Prompt/Review/Evening.md` (the prompt is now just persona + synthesis). Per-section error surfacing; `--date` / `--no-whatsapp` / `--no-transcribe` flags.
  gather-review.ts                     — Weekly/Monthly review gatherer (`pnpm gather:weekly --end <date>` / `pnpm gather:monthly --month <YYYY-MM>`). Windowed sibling of gather-evening (no WhatsApp); digest at `/tmp/espejo-review-gather/<window>-<label>.md`. Deterministic half of Weekly.md / Monthly.md. **Always pass `--month` for monthly** — it defaults to the current calendar month via `now()`, so a review written a day into the next month would otherwise gather the wrong month.
  embed-entries.ts                     — Batch embed; run after sync to populate vector column.
  write-tomo.ts                        — Tomo writer: `--plan-only` → 6 anchored-essay candidates (flow format retired); `--pick=2,3,5` writes several IN PARALLEL (cap 2, allSettled). Writes Spanish only — bilingual interleave + EPUB + Kindle send are Phase 4 (`scripts/book/rebuild-tomo.ts`). Inline glosses / open-questions retired; ~4000-word body; faithful/structural bilingual carries the teaching. Model = `config.models.bookWriter`. See `Artifacts/Prompt/Spanish/Tomo.md`.
  import-conjugations.ts               — Idempotent re-import of Spanish corpus into the read-only `conjugations` table.
  migrate.ts, deploy-smoke.ts          — Schema migration + post-deploy check.
  dedup/{retrieve,council,synthesize,apply,check-faithfulness}.{ts,mjs}
                                       — Multi-stage Pending→Insight dedup. Dry-run by default; `--apply` to mutate.
  vault-fs-watcher.ts, vault-fs/       — fswatch → `vault_fs_events` ingestor + launchd plists.
  backfill-*.ts, migrate-*.ts, cleanup-*.ts
                                       — One-off historical migrations. Consult before re-running; some are destructive.
specs/
  schema.sql, tools.spec.ts            — Canonical schema + tool contracts. Always source of truth.
  *.md                                 — Plans, research, removed-feature history. `*-plan.md` are implemented unless marked `[Planned]` or `[Stub]`.
data/
  conjugations-es/, verb-frequency-es.txt
                                       — Vendored Spanish corpora (LGPL-3.0 + CC-BY-SA-4.0). Rebuild via `pnpm import:conjugations`.
docs/                                  — Deep documentation (see Deep Docs below).
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

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Write/update/delete MCP tools for journal entries — Day One is the canonical writer for `entries`; new long-form notes go into the Obsidian vault and flow through the artifact sync.
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)

See `specs/*.md` files marked `[Stub]` or `[Planned]` for upcoming features.

## Gotchas

- **Oura `day_summary` lags 1 day.** For today's signal use `recovery`/`stress` second-level data, not `day_summary`.
- **Ports**: dev PG `5434`, test PG `5433` (5432 is claimed by the greenline project).
- **Zod rejects `null` for optional date strings** — see `specs/2026-04-09-fix-mcp-null-optional-params-plan.md` before adding new optional-date params.
- **DayOne sync**: null-byte/backslash handling required on text fields; `ZHASDATA=0` attachments are iCloud-only and must be skipped.
- **`.env.production.local` is the only file with prod creds.** Never commit it; never echo its contents to chat or logs. When sourcing values, pipe through `cut -d= -f2-` rather than `cat`-ing the file.
- **Prod DB session TZ is UTC.** Bucket `timestamptz` columns by `(col AT TIME ZONE 'Europe/Madrid')::date` before grouping by day, or you'll silently lose Madrid 00:00–02:00 rows. `DATE` columns need no cast.
- **Embed after sync.** `pnpm sync:obsidian` inserts new artifacts with NULL embeddings. Run `pnpm embed:prod` before any retrieval / dedup or fresh pendings get silently dropped from semantic search.
- **Persistent memory at `~/.claude/projects/-Users-mitch-Projects-espejo/memory/MEMORY.md`** — read it. Captures feedback, project state, and gotchas that don't belong in this file (private corrections, partner names, evolving prompt conventions, council-config drift, etc.).
- **Agent tool-call audit**: Telegram chat + vault-prompt flows insert a row in `activity_logs` **only when at least one tool call fires** (`toolRecords.length > 0`). Pure-text replies don't create an `activity_logs` row — use `chat_messages` or `usage_logs` for no-tool runs. To inspect a tool-using run: `SELECT created_at, jsonb_pretty(tool_calls) FROM activity_logs WHERE tool_calls::text LIKE '%<tool_name>%' ORDER BY created_at DESC LIMIT 5;`.
- **Universal usage log**: `usage_logs` records every MCP tool call (including from Claude desktop/mobile, which `activity_logs` does not capture), every HTTP request (excluding `/health`), Telegram tool dispatch (mirrors the per-tool slice of `activity_logs`), and cron fires (oura-sync, obsidian-sync). Schema: `(ts, source, surface, actor, action, args jsonb, ok, error, duration_ms, meta jsonb)`. Examples:
  - "Which MCP tools fired in the last 24h": `SELECT action, surface, COUNT(*) FROM usage_logs WHERE source = 'mcp' AND ts > NOW() - INTERVAL '1 day' GROUP BY 1,2 ORDER BY 3 DESC;`
  - "Did anything error today": `SELECT ts, source, action, error FROM usage_logs WHERE NOT ok AND ts > NOW() - INTERVAL '1 day' ORDER BY ts DESC;`
  - Use this table for traffic/source breakdowns; keep `activity_logs` for full-conversation Telegram audits (memories, cost, complete tool transcript).
- **`daily_metrics` upsert preserves `created_at`**: the `ON CONFLICT (date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg` clause only touches `weight_kg`, so `created_at` reflects the original insert. Use `activity_logs` (not `daily_metrics.created_at`) to determine when a value was last written.
- **Chat logs** (useful when Mitch asks "what did I do last week"): **query the DB you ingested at Session Init.** `agent_sessions` holds Claude Code / OpenCode / Codex prompt-and-response transcripts; `chat_messages` holds Telegram. Only fall back to the raw files when the ingestors haven't run for this session — and when that happens, run `pnpm ingest:sessions` first if you can. The raw paths (for reference / fallback only):
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
