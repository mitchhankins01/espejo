# espejo-mcp

MCP server + Telegram chatbot for semantic journal search over Day One exports in PostgreSQL + pgvector.

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
      entries.ts    — Entry CRUD + search queries.
      artifacts.ts  — Artifact CRUD + search + graph queries.
      oura.ts       — Oura biometric data queries.
      chat.ts       — Chat message storage + retrieval.
      weights.ts    — Weight tracking queries.
      observability.ts — Activity logs.
      media.ts      — Media attachment queries.
      templates.ts  — Entry template queries.
      content-search.ts — Unified cross-type search.
      obsidian.ts   — Obsidian vault sync queries.
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
    get-obsidian-sync-status.ts — Obsidian vault sync status.
    save-evening-review.ts — Save evening review as knowledge artifact.
  telegram/
    webhook.ts      — Telegram webhook handler. Validates secret token, processes updates, routes commands.
    updates.ts      — Update deduplication, per-chat queue, fragment reassembly.
    agent.ts        — Agent orchestrator. Delegates to agent/ submodules.
    agent/          — Agent internals, split from monolithic agent.ts.
      constants.ts  — Token budgets, model defaults, retry limits.
      context.ts    — System prompt + context building (oura, spanish).
      tools.ts      — Tool dispatch and result formatting.
      compaction.ts — Conversation compaction.
      truncation.ts — Message truncation for context window management.
    client.ts       — Telegram Bot API client. sendMessage/sendVoice, retry, chunking.
    voice.ts        — Voice processing: Whisper transcription, TTS synthesis.
    media.ts        — Photo/document processing: vision, text/PDF extraction.
    evening-review.ts — Evening review and morning journal session prompts.
    soul.ts         — Soul state snapshot, evolution, system prompt building.
    pulse.ts        — Self-healing quality loop: diagnose drift, apply soul repairs.
    network-errors.ts — Recoverable network error classification for retry logic.
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
    sync.ts         — Obsidian vault sync engine: R2 fetch + DB upserts + timer.
    parser.ts       — Markdown frontmatter parser for Obsidian notes.
    extraction.ts   — Content extraction from Obsidian markdown.
    wiki-links.ts   — Wiki-link parsing and resolution.
  notifications/
    on-this-day.ts  — "On This Day" morning reflection notification.
  utils/
    dates.ts        — Shared timezone-aware date utility (todayInTimezone).
  transports/
    http.ts         — Express HTTP bootstrap. Mounts routes and middleware.
    oauth.ts        — OAuth token validation for HTTP API authentication.
    routes/         — Route handlers, split from monolithic http.ts.
      activity.ts   — Activity log endpoints.
      artifacts.ts  — Artifact CRUD + search + graph endpoints.
      entries.ts    — Entry CRUD + media upload endpoints.
      health.ts     — Health check endpoint.
      metrics.ts    — Legacy metrics ingestion endpoint.
      observability.ts — Observability endpoints.
      templates.ts  — Entry template CRUD endpoints.
      types.ts      — Shared route type definitions.
      weights.ts    — Weight tracking endpoints.
    middleware/
      auth.ts       — Bearer token authentication middleware.
  storage/
    r2.ts           — Cloudflare R2 client. Upload, exists check, public URL.
  formatters/
    entry.ts        — Raw DB row → human-readable string with emoji, metadata, media URLs.
    search-results.ts — Ranked results with RRF score context.
scripts/
  sync-dayone.ts    — DayOne.sqlite → PG. Idempotent (ON CONFLICT DO UPDATE).
  embed-entries.ts  — Batch embed all entries missing embeddings.
  migrate.ts        — Runs SQL files, tracks applied migrations in _migrations table.
  import-verbs.ts   — Downloads Fred Jehle Spanish verb CSV, bulk inserts ~11k rows.
  sync-weight.ts    — Sync weight data to production.
  sync-oura.ts      — Backfill/sync Oura biometrics into Postgres (pnpm sync:oura).
  migrate-entries-to-artifacts.ts — One-time migration of entries into knowledge artifacts.
  deploy-smoke.ts   — Post-deploy smoke test.
  telegram-setup.ts — Set/check/delete Telegram webhook.
specs/
  schema.sql        — Canonical DB schema.
  tools.spec.ts     — Tool contracts: params, types, descriptions, examples.
  — Implemented specs:
  spanish-learning.md, telegram-chatbot-plan.md, telegram-personality-plan.md,
  self-healing-organism.md, episodic-memory.md, memory-v2.md,
  oura-integration-plan.md, knowledge-artifacts.md,
  web-app.spec.md, web-quick-switcher.md,
  web-semantic-links.md, web-graph-view.md, web-feature-rollout.md,
  web-journaling.md
  — Research: ltm-research.md
  — Planned/Stub: aws-sst-migration-plan.md, chat-archive.md,
  proactive-checkins.md, project-management.md
  fixtures/
    seed.ts         — Test data with pre-computed embeddings for determinism.
packages/
  shared/           — @espejo/shared workspace. Shared TypeScript types between MCP server and web frontend.
web/                — React + Vite frontend (@espejo/web workspace). Knowledge base CRUD editor.
  src/
    main.tsx        — Entry point. Routes: /, /new, /:id, /journal, /templates, /weight, /db.
    api.ts          — API client for artifacts, entries, templates, and weights.
    index.css       — Tailwind CSS v4 entry + theme vars.
    constants/      — Shared artifact constants (kinds, labels, badge class mapping).
    pages/          — ArtifactList/Create/Edit + EntryList/Create/Edit + TemplateList/Create/Edit + Weight + DbObservability.
    components/     — AuthGate, KindSelect, SourcePicker, MarkdownEditor, QuickSwitcher, GraphView, MediaGallery, MediaUpload, TemplatePicker.
  e2e/              — Playwright e2e tests (auth, CRUD, filters, pagination, theme).
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
3. Push `main`.
4. Watch Railway deployment to completion immediately after push (Railway dashboard/logs) and confirm it succeeds.

## Code Style

- TypeScript strict mode — no `any` unless absolutely necessary (and add a comment explaining why)
- All functions have explicit return types
- Use `zod` for runtime validation of tool input params
- Prefer `const` over `let`, never use `var`
- Use early returns over nested conditionals
- Error messages should be actionable — say what went wrong AND what to do about it
- No `console.log` in `src/` — use structured logging or MCP SDK's logging if needed
- `console.log` is fine in `scripts/` for progress output

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server + transport |
| `pg` | PostgreSQL client |
| `pgvector` | pgvector type support for node-postgres |
| `openai` | Embedding generation |
| `zod` | Runtime param validation |
| `dotenv` | Env file loading |
| `express` | HTTP server for REST API, Telegram webhook, and MCP StreamableHTTP transport |
| `@aws-sdk/client-s3` | Cloudflare R2 media storage (S3-compatible) |
| `better-sqlite3` | Read DayOne.sqlite during sync |
| `@anthropic-ai/sdk` | Claude agent for Telegram chatbot conversations |
| `multer` | Multipart form-data parsing for media upload |

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Write/update/delete MCP tools for journal entries (entries now have CRUD via REST API and web UI; artifacts have CRUD via REST API)
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)
- Auto-purge of compacted messages (function exists in `queries.ts`, not wired up)

See `specs/*.md` files marked `[Stub]` or `[Planned]` for upcoming features.

## Obsidian Artifacts (Local Vault)

`Artifacts/` is a symlink to `~/Documents/Artifacts` — Mitch's Obsidian vault containing knowledge notes, writing, and reference material. It is gitignored.

When the user asks about "artifacts", "notes", "Obsidian", or wants to look something up in their vault, read/search files under `Artifacts/` on the filesystem. This is separate from the DB-backed knowledge artifacts in `src/db/queries/artifacts.ts` — those are structured records in Postgres. The Obsidian vault is plain markdown files on disk.

Common requests:
- "Look at my note on X" → `Glob` / `Grep` under `Artifacts/`
- "Search my Obsidian for Y" → `Grep` under `Artifacts/`
- "What artifacts do I have about Z" → could mean either; ask if ambiguous, but default to filesystem if the context is about notes/writing

## Deep Docs

- [Testing](docs/testing.md) — test tiers, isolation, fixtures, coverage, assertions
- [Development](docs/development.md) — environments, common tasks, DB access
- [Deployment](docs/deployment.md) — CI/CD, Railway, Telegram setup
- [Telegram](docs/telegram.md) — bot features, commands, soul, Spanish, Oura, insights
- [Architecture](docs/architecture.md) — REST API endpoints, spec workflow
