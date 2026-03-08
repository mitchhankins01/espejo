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
    queries.ts      — ALL SQL lives here. Parameterized queries only. Never string interpolation.
    embeddings.ts   — OpenAI embedding helper. Used by search tool at query time + embed script.
  tools/
    search.ts       — Hybrid RRF search. The most important tool.
    get-entry.ts    — Single entry by UUID.
    get-entries-by-date.ts — Date range query.
    on-this-day.ts  — MM-DD across all years.
    find-similar.ts — Cosine similarity from a source entry.
    list-tags.ts    — All tags with counts.
    entry-stats.ts  — Writing frequency and trends.
    conjugate-verb.ts — Spanish verb conjugation lookup from reference DB.
    log-vocabulary.ts — Track Spanish vocabulary with SRS state per chat.
    spanish-quiz.ts — Spaced-repetition quiz: get due cards, record reviews, stats.
    get-artifact.ts — Single artifact by ID with sources and version.
    list-artifacts.ts — List/filter artifacts by kind, tags, pagination.
    search-artifacts.ts — Hybrid RRF search over knowledge artifacts.
    search-content.ts — Unified cross-type search over entries + artifacts.
    get-oura-summary.ts — Single-day Oura health snapshot.
    get-oura-weekly.ts — 7-day Oura overview with averages.
    get-oura-trends.ts — N-day trend analysis for a metric.
    get-oura-analysis.ts — Multi-type analysis: sleep quality, anomalies, HRV trend, temperature, best sleep.
    oura-compare-periods.ts — Side-by-side metrics comparison between two date ranges.
    oura-correlate.ts — Pearson correlation between two health metrics.
    list-todos.ts   — List/filter todos by status, quadrant, parent, focus.
    create-todo.ts  — Create todo with urgency/importance/parent_id.
    update-todo.ts  — Partial todo update, auto-sets completed_at on done.
    complete-todo.ts — Mark todo done + clear focus.
    set-todo-focus.ts — Set/clear "The One Thing" focus.
  todos/
    context.ts      — Todo context prompt builder for Telegram agent injection.
  telegram/
    webhook.ts      — Telegram webhook handler. Validates secret token, processes text/voice/photo/doc updates, dispatches responses. Routes /morning, /evening, /compact, /digest, /assess commands.
    updates.ts      — Update deduplication, per-chat queue, fragment reassembly.
    agent.ts        — Anthropic/OpenAI agent loop. Context building, tool dispatch, compaction, pattern extraction. Includes Spanish coaching with adaptive difficulty.
    client.ts       — Telegram Bot API client. sendMessage/sendVoice, retry, chunking, HTML parse fallback.
    voice.ts        — Voice processing: Telegram download, Whisper transcription, TTS synthesis helpers.
    media.ts        — Photo/document processing: Telegram file download, OpenAI vision for photos, text/PDF extraction for documents.
    evening-review.ts — Agent mode prompts for evening review and morning journal sessions.
    soul.ts         — Soul state snapshot, evolution during compaction, system prompt building.
    pulse.ts        — Self-healing quality loop: diagnose drift, propose/apply soul repairs autonomously.
    network-errors.ts — Recoverable network error classification for retry logic.
  spanish/
    analytics.ts    — Interface-agnostic Spanish learning analytics. Pure functions: digest building, trend analysis, formatting.
    assessment.ts   — LLM-as-judge Spanish conversation quality assessment. DI-based client interface.
  insights/
    engine.ts       — Background insight engine: timer, advisory lock, run loop, dedup, throttle, notify.
    analyzers.ts    — Pure analysis functions: temporal echoes, biometric correlations, stale todos.
    formatters.ts   — InsightCandidate → Telegram HTML notification formatting.
  oura/
    client.ts       — Oura API v2 client.
    sync.ts         — Oura sync engine: API fetch + DB upserts + advisory lock + timer.
    context.ts      — Oura context prompt builder for Telegram agent injection.
    formatters.ts   — Oura tool response formatting helpers.
    analysis.ts     — 1100-line statistical analysis module (pure functions): trend detection, outlier detection (IQR + Z-score), correlations, sleep debt/regularity/stage ratios, HRV recovery patterns, temperature analysis, day-of-week patterns.
    types.ts        — TypeScript interfaces for stored Oura data.
  utils/
    dates.ts        — Shared timezone-aware date utility (todayInTimezone). Used by tools and sync.
  transports/
    http.ts         — Express HTTP server. MCP StreamableHTTP transport, Telegram webhook, REST API endpoints (activity logs, Spanish dashboard/assessments).
    oauth.ts        — OAuth token validation for HTTP API authentication.
  storage/
    r2.ts           — Cloudflare R2 client. Upload, exists check, public URL.
  formatters/
    entry.ts        — Raw DB row → human-readable string with emoji, metadata, media URLs.
    search-results.ts — Ranked results with RRF score context.
scripts/
  sync-dayone.ts    — DayOne.sqlite → PG. Idempotent (ON CONFLICT DO UPDATE).
  embed-entries.ts  — Batch embed all entries missing embeddings.
  migrate.ts        — Runs SQL files, tracks applied migrations in _migrations table.
  import-verbs.ts   — Downloads Fred Jehle Spanish verb CSV from GitHub, bulk inserts ~11k conjugation rows.
  sync-weight.ts    — Sync weight data to production.
  sync-oura.ts      — Backfill/sync Oura biometrics into Postgres (pnpm sync:oura).
  migrate-entries-to-artifacts.ts — One-time migration of entries into knowledge artifacts.
  deploy-smoke.ts   — Post-deploy smoke test.
  telegram-setup.ts — Set/check/delete Telegram webhook.
specs/
  schema.sql        — Canonical DB schema.
  tools.spec.ts     — Tool contracts: params, types, descriptions, examples.
  — Implemented specs:
  spanish-learning.md — [Implemented] Spanish learning infrastructure (phases, tables, tools).
  telegram-chatbot-plan.md — [Implemented] Telegram chatbot with pattern memory.
  telegram-personality-plan.md — [Implemented] Soul personality system (one evolving identity).
  self-healing-organism.md — [Implemented] Autonomous quality loop (pulse checks, soul repairs).
  episodic-memory.md — [Implemented] Episodic memory hardening notes (historical v1 fact/event model).
  memory-v2.md      — [Implemented] Memory v2: 3 kinds, MCP tools (remember/save_chat/recall/reflect), decoupled compaction, shared soul.
  oura-integration-plan.md — [Implemented] Oura Ring integration (5 phases, 6 tools, 8 tables).
  knowledge-artifacts.md — [Implemented] Knowledge base (artifacts, unified search, web app).
  todos.md          — [Implemented] Todo system (Eisenhower quadrants, focus, hierarchy).
  web-app.spec.md   — [Implemented] Web app (React + Vite knowledge base + todo frontend).
  web-tag-filtering.md — [Implemented] Tag pill filtering on artifact list.
  web-quick-switcher.md — [Implemented] Cmd+K global navigation with fuzzy search.
  web-semantic-links.md — [Implemented] Cosine similarity + wiki-link based artifact linking.
  web-graph-view.md — [Implemented] Force-directed graph visualization of artifact connections.
  web-feature-rollout.md — [Implemented] Record of completed web feature additions.
  — Research:
  ltm-research.md   — [Research] Evidence-based long-term memory architecture analysis.
  — Planned / Stub specs:
  aws-sst-migration-plan.md — [Planned] Future AWS/SST migration (not implemented).
  insight-engine.md — [Implemented] Background dot-connecting worker: temporal echoes, biometric correlations, stale todo detection.
  chat-archive.md   — [Merged] into memory-v2.md as `save_chat` tool.
  proactive-checkins.md — [Stub] Telegram bot proactive outreach for data gathering.
  project-management.md — [Stub] ADHD-tailored project management extending todos.
  fixtures/
    seed.ts         — Test data with pre-computed embeddings for determinism.
packages/
  shared/           — @espejo/shared workspace. Shared TypeScript types between MCP server and web frontend.
web/                — React + Vite frontend (@espejo/web workspace). Knowledge base CRUD editor.
  src/
    main.tsx        — Entry point. Routes: /, /new, /:id, /todos, /todos/new, /todos/:id.
    api.ts          — API client for artifacts (list/search/related/graph), entries picker, and todos.
    index.css       — Tailwind CSS v4 entry + theme vars (artifact kind badges + todo status badges).
    constants/      — Shared artifact constants (kinds, labels, badge class mapping).
    pages/          — ArtifactList/ArtifactCreate/ArtifactEdit + TodoList/TodoCreate/TodoEdit.
    components/     — AuthGate nav, KindSelect, StatusSelect, EisenhowerMatrix, TagInput, SourcePicker, MarkdownEditor, QuickSwitcher, GraphView.
  e2e/              — Playwright e2e tests (auth, CRUD, filters, pagination, theme).
```

## Key Patterns

### All SQL in queries.ts

Every database query is a function in `src/db/queries.ts`. Tools call these functions — they never write SQL directly. Queries use parameterized placeholders (`$1`, `$2`), never string interpolation.

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

Both retrievals pull top-20 candidates. The merge produces the final ranked list. Optional filters (date range, tags, city) are applied as WHERE clauses in BOTH retrievals to keep results consistent.

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

### Tags Are Normalized

Tags live in a separate `tags` table with a junction table `entry_tags`. This enables efficient tag-based queries and `list_tags` aggregation. When importing, upsert tags (`ON CONFLICT (name) DO NOTHING`) and create junction records.

### Sync Is Idempotent

`scripts/sync-dayone.ts` reads directly from the DayOne.sqlite database and uses `ON CONFLICT (uuid) DO UPDATE` so re-running it updates existing entries. Run `pnpm sync` any time to pick up new or modified entries from Day One.

Media files (photos, videos, audio) are uploaded to Cloudflare R2 during sync if R2 credentials are configured. The sync checks if each file already exists in R2 (HEAD request) and skips re-upload. Use `--skip-media` for a quick metadata-only sync. Attachments with `ZHASDATA=0` (iCloud-only, not downloaded locally) are skipped with a warning.

## Test Strategy

### Two Test Tiers

**Unit tests** (`tests/tools/`, `tests/formatters/`, `tests/oura/`, `tests/insights/`, `tests/utils/`):
- No database needed
- Test param validation, formatter output, spec conformance
- Fast — run in milliseconds

**Integration tests** (`tests/integration/`):
- Require PostgreSQL with pgvector
- Test actual SQL queries, RRF ranking, embedding similarity
- Docker Compose auto-starts a test DB on port 5433 via vitest `globalSetup`
- Test DB uses `tmpfs` — RAM-backed, no disk persistence, fast teardown

### Test Isolation

Each test gets a clean database state:
- `beforeEach`: truncate all tables, re-seed from fixtures
- Fixtures include pre-computed embedding vectors (no OpenAI calls during tests)
- Test DB runs on port 5433 (dev DB is on port 5434)
- Test Docker Compose uses project name `espejo-test` (`-p espejo-test`) to isolate from dev containers — test teardown won't destroy dev volumes

### Pre-Computed Embeddings in Fixtures

`specs/fixtures/seed.ts` contains test entries with hardcoded 1536-dimension embedding vectors. This makes tests:
- **Deterministic** — same results every run, no API variability
- **Fast** — no network calls
- **Free** — no OpenAI charges during CI

For entries that should be "semantically similar" in tests, their fixture vectors should be similar (copy a vector and add small random noise). The exact values don't matter for unit tests.

### Custom Assertions

`tests/helpers/assertions.ts` provides assertions with actionable error messages:

```typescript
// Instead of: "expected [] to have length > 0"
// You get:    "Expected results for query 'nervous system' but got 0.
//              Hint: Check embeddings exist in fixtures.
//              Hint: Verify RRF query handles NULL embeddings."
```

When writing new assertions, always include a `Hint:` pointing to the file and function most likely to contain the bug.

## Environment Separation

| Environment | DB Name | Port | Config Source | Notes |
|-------------|---------|------|---------------|-------|
| Development | `journal_dev` | 5434 | `.env` (gitignored) | Full journal data, persistent volume |
| Test | `journal_test` | 5433 | `.env.test` | Fixture data only, tmpfs (RAM), auto-managed |
| Production | Railway PG | — | Railway env vars | `DATABASE_URL` injected by Railway |

The `src/config.ts` module selects the right config based on `NODE_ENV`. Default is `development`.

### Dotenv Loading

Scripts and `src/config.ts` use env-aware dotenv:

```typescript
import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
}
```

- **Development/test**: Loads `.env` or `.env.test` with `override: true` (overrides shell env vars)
- **Production**: Skips dotenv entirely — uses env vars from the caller (Railway, or CLI for manual sync)

### Connecting to databases with psql

`psql` is installed via `libpq` (not in PATH by default — prefix commands or add to shell):

```bash
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
```

**Dev DB** (credentials in `.env`):
```bash
source .env && psql "$DATABASE_URL"
```

**Prod DB** (credentials in `.env.production.local`):
```bash
source .env.production.local && psql "$DATABASE_URL"
```

**Claude Code can query either DB directly** — just say "query dev" or "query prod" and I'll source the appropriate env file and run the SQL via Bash.

**Note (GUI tools like TablePlus):** Use the fields from `DATABASE_URL` in `.env`. If you get `database "dev" does not exist`, the tool is using the username as the database name — make sure to specify `journal_dev` explicitly.

## Adding a New Tool

1. Add the tool spec to `specs/tools.spec.ts` — define name, description, params, types
2. Write a failing test in `tests/tools/<tool-name>.test.ts`
3. Add the SQL query to `src/db/queries.ts`
4. Write a formatter in `src/formatters/` if the tool needs custom output formatting
5. Implement the tool in `src/tools/<tool-name>.ts`
6. Register it in `src/server.ts`
7. Run `pnpm check` — everything must pass
8. Update this file's tool list if needed

## Common Tasks

### Reset dev database

```bash
docker compose down -v && docker compose up -d
pnpm migrate
pnpm sync
pnpm embed
```

### Run only integration tests

```bash
pnpm test:integration
```

This auto-starts the test DB container. You don't need to manage Docker manually.

### Run only unit tests

```bash
pnpm test:unit
```

No Docker needed.

### Add a migration

Create a new `.sql` file in a `migrations/` directory (if using file-based migrations) or add to `specs/schema.sql` and reset. For a personal project, schema resets are fine — no need for reversible migrations.

### Sync local data to production

After journaling new entries in Day One, push them to Railway:

```bash
# 1. Sync new entries from DayOne.sqlite → local dev DB
pnpm sync --skip-media

# 2. Embed any new entries missing embeddings
pnpm embed

# 3. Push to production (Railway)
NODE_ENV=production DATABASE_URL=<railway_url> OPENAI_API_KEY=<key> pnpm sync --skip-media
NODE_ENV=production DATABASE_URL=<railway_url> OPENAI_API_KEY=<key> pnpm embed
```

`NODE_ENV=production` skips dotenv loading, so the inline `DATABASE_URL` is used directly. Both sync and embed are idempotent — they only process new/changed entries.

For media upload to R2, drop `--skip-media` and add R2 env vars:

```bash
NODE_ENV=production DATABASE_URL=<url> R2_ACCOUNT_ID=<id> R2_ACCESS_KEY_ID=<key> \
  R2_SECRET_ACCESS_KEY=<secret> R2_BUCKET_NAME=<bucket> DAYONE_SQLITE_PATH=<path> pnpm sync
```

### Re-embed after model change

If you change the embedding model, re-embed everything:

```bash
pnpm embed --force   # Re-embeds all entries, not just those missing embeddings
```

## CI/CD

### GitHub Actions

`.github/workflows/ci.yml` runs on every push/PR to `main` with two jobs:

1. **lint** — `pnpm typecheck` + `pnpm lint`
2. **test** (needs lint) — `pnpm test -- --coverage` (unit + integration + strict coverage thresholds)

Integration tests use Docker Compose inside CI (same as local). The vitest `globalSetup` starts the test DB container automatically. Docker is pre-installed on GitHub's `ubuntu-latest` runners.

### Coverage

Coverage is enforced via `@vitest/coverage-v8` with a mixed policy in `vitest.config.ts`: global thresholds (`lines/functions/statements=95`, `branches=90`) plus 100% thresholds for critical modules (`src/db/queries.ts`, `src/transports/http.ts`, `src/tools/search.ts`, `src/oura/analysis.ts`). `pnpm check` runs coverage locally too (`pnpm test:coverage`).

Files excluded from coverage via config: `src/index.ts` (entry point), `src/db/client.ts` (module-level pool), `src/transports/oauth.ts` (runtime-only OAuth), and `src/oura/types.ts` (type-only). Defensive branches in `src/db/queries.ts`, `src/server.ts`, and `src/oura/analysis.ts` use `/* v8 ignore next */` pragmas.

Run `pnpm test:coverage` locally to check coverage before pushing.

### Local CI with act

[act](https://github.com/nektos/act) runs GitHub Actions workflows locally in Docker. Configured via `.actrc`.

```bash
act push -j lint      # Typecheck + lint (works fully on macOS)
act push              # Full pipeline (integration tests need Docker-in-Docker)
```

The `lint` job runs cleanly on Apple Silicon. The `test` job may fail locally due to Docker-in-Docker limitations under QEMU emulation — this is expected. Use `pnpm check` for full local validation including integration tests.

### Pipeline

| Environment | Trigger | What runs |
|-------------|---------|-----------|
| Local | `pnpm check` | typecheck → lint → test + coverage (100%) |
| Local (act) | `act push -j lint` | typecheck → lint (in Docker, matches CI) |
| CI | Push/PR to main | lint → test + coverage (100%) |
| Production | Merge to main | Railway auto-deploy via Dockerfile |

## Deployment

Deployed to Railway. Mirrors the deployment pattern from [oura-ring-mcp](https://github.com/mitchhankins01/oura-ring-mcp).

### Main Branch Release Protocol

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

**Required Railway env vars:**
- `DATABASE_URL` — auto-set by Railway PostgreSQL addon (must have pgvector extension)
- `OPENAI_API_KEY` — for query-time embedding in `search_entries`
- `NODE_ENV=production`
- `R2_PUBLIC_URL` — Cloudflare R2 public bucket URL

**Optional:**
- `PORT` — auto-set by Railway
- `MCP_SECRET` — static bearer token for Claude Desktop HTTP access
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — for media sync

The Dockerfile is multi-stage: TypeScript build → slim Node.js runtime. The production image does not include dev dependencies, test fixtures, or Docker Compose files.

### Telegram Bot Deployment

The Telegram chatbot is opt-in. If `TELEGRAM_BOT_TOKEN` is set in production, these vars are required (startup will fail otherwise):

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Webhook verification (you generate this — any random string) |
| `TELEGRAM_ALLOWED_CHAT_ID` | Your personal chat ID (single-user access control) |
| `OPENAI_API_KEY` | Embeddings + Whisper transcription + voice reply TTS |
| `ANTHROPIC_API_KEY` | Required only when `TELEGRAM_LLM_PROVIDER=anthropic` (default provider) |

**Optional Telegram behavior/config vars:**

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_LLM_PROVIDER` | Conversation model provider: `anthropic` or `openai` |
| `OPENAI_CHAT_MODEL` | OpenAI chat model when `TELEGRAM_LLM_PROVIDER=openai` |
| `ANTHROPIC_MODEL` | Anthropic model when `TELEGRAM_LLM_PROVIDER=anthropic` |
| `TELEGRAM_VOICE_REPLY_MODE` | Voice reply policy: `off`, `adaptive`, or `always` |
| `TELEGRAM_VOICE_REPLY_EVERY` | In adaptive mode, send voice for every Nth text-origin message |
| `TELEGRAM_VOICE_REPLY_MIN_CHARS` | Lower character bound for voice-eligible responses |
| `TELEGRAM_VOICE_REPLY_MAX_CHARS` | Upper character bound for voice-eligible responses |
| `OPENAI_TTS_MODEL` | OpenAI speech model used for voice replies |
| `OPENAI_TTS_VOICE` | Voice preset used for TTS output |

**Setting up the webhook:**

```bash
# Generate a secret token
openssl rand -hex 32

# Set the webhook (reads TELEGRAM_BOT_TOKEN and TELEGRAM_SECRET_TOKEN from env)
pnpm telegram:setup https://your-app.railway.app/api/telegram

# Check webhook status
pnpm telegram:setup --info

# Remove webhook (for debugging)
pnpm telegram:setup --delete
```

**Finding your chat ID:**

1. Message your bot on Telegram
2. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Look for `"chat":{"id": 123456789}` in the response
4. Set `TELEGRAM_ALLOWED_CHAT_ID=123456789` in Railway

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

## Telegram Chatbot

A Telegram chatbot with pattern-based long-term memory and an evolving personality. Deployed to Railway, opt-in via `TELEGRAM_BOT_TOKEN`. Original design: `specs/telegram-chatbot-plan.md`.

**What it does:**
- Conversational interface powered by Anthropic or OpenAI (configurable provider)
- Uses MCP tools in the Telegram agent loop (journal retrieval + Spanish learning + Oura analytics + memory tools + todos)
- Spanish language tutor: conducts conversations primarily in Spanish, corrects conjugation mistakes, tracks vocabulary with FSRS spaced repetition, and adapts difficulty based on real review performance
- Redirects weight logging to the web Weight page (`/weight`) instead of MCP tool calls
- Accepts text, voice, photo, and document messages (with OCR/text extraction for media)
- Voice messages transcribed via OpenAI Whisper
- Optionally responds with Telegram voice notes using adaptive/fallback rules
- Stores long-term memory intentionally through `remember`/`save_chat`; compaction is summary + trim only
- Logs activity per agent run (memories retrieved, tool calls with full results) in `activity_logs` table

**Commands:**
- `/evening` — Evening review mode: guided journaling session with somatic check-ins, system assessments (escalera, boundaries, attachment), and Spanish-primary conversation
- `/morning` — Morning flow mode: free-flow morning journal session
- `/compact` — Force conversation compaction summary (memory note)
- `/digest` — Spanish learning summary: vocabulary stats, retention rates, grade/lapse trends, adaptive status tier, latest assessment
- `/assess` — Trigger LLM-as-judge evaluation of recent Spanish conversation quality (complexity, grammar, vocabulary, code-switching ratio)

**Pattern memory:**
- 3 pattern kinds with typed decay scoring: `identity`, `preference`, `goal`
- Compaction trigger: size-based (12k token budget) for context management
- Memory creation path: `remember` and `save_chat` tools (dedup by canonical hash + ANN similarity)
- Retrieval: hybrid semantic + text search with RRF merge and score floors
- Maintenance: consolidation, stale review, and active cap enforcement
- DB tables: `chat_messages`, `patterns`, `pattern_observations`, `pattern_relations`, `pattern_aliases`, `pattern_entries`, `api_usage`, `memory_retrieval_logs`
- Provenance fields: `patterns.source_type/source_id`, `pattern_observations.source_type/source_id`

Memory v2 supersedes the earlier v1 `fact`/`event` taxonomy in active retrieval and storage. See `specs/memory-v2.md`.

### Soul Personality System

One evolving personality that grows through interaction. Design: `specs/telegram-personality-plan.md` (updated in memory-v2 to global state).

- `soul_state` singleton table: identity summary, relational commitments, tone signature, growth notes, version counter
- Soul state evolves in the main agent loop with guardrails; pulse checks can apply additional repairs
- `soul_state_history` table: audit trail of every soul mutation with reason
- Soul prompt section injected into system prompt on every turn

### Self-Healing Quality Loop

Autonomous quality monitoring and personality drift correction. Design: `specs/self-healing-organism.md`.

- `soul_quality_signals` table: tracks user reactions (felt_personal, felt_generic, correction, positive_reaction)
- `pulse_checks` table: periodic diagnosis of personality health (healthy, drifting, stale, overcorrecting)
- `diagnoseQuality()` → `applySoulRepairs()` pipeline: pure functions that analyze signals and adjust soul state
- `cost_notifications` table: 12-hour spend summary tracking

### Activity Logs

Per-agent-run observability. Each time the bot processes a message, it logs:
- Memories retrieved (patterns injected into context)
- Tool calls with full input/output results
- Cost of the run

DB table: `activity_logs` with `chat_id`, `memories` (JSONB), `tool_calls` (JSONB), `cost_usd`.

HTTP endpoints for inspection:
- `GET /api/activity` — Recent activity logs (`limit`, `since`, `tool`)
- `GET /api/activity/:id` — Single activity log by ID

### Spanish Learning Infrastructure

Full design: `specs/spanish-learning.md`.

**3 MCP tools:**
- `conjugate_verb` — Look up Spanish verb conjugations by infinitive, optionally filtered by mood/tense. Data from Fred Jehle database (~11k rows).
- `log_vocabulary` — Track a vocabulary word per chat with translation, part of speech, regional context, SRS state. Upserts by `(chat_id, word, region)`.
- `spanish_quiz` — Spaced-repetition flow: `get_due` (fetch due/new cards), `record_review` (FSRS grade 1-4), `stats` (progress summary).

**DB tables:**
- `spanish_verbs` — Reference conjugation data (~11k rows, imported via `pnpm import:verbs`)
- `spanish_vocabulary` — Per-chat vocabulary with FSRS state (stability, difficulty, reps, lapses, next_review)
- `spanish_reviews` — Audit trail of every review event with before/after SRS state
- `spanish_progress` — Daily learning snapshots per chat (words learned, reviews, streak)
- `spanish_profiles` — Per-chat learner profile (CEFR level, known tenses, focus topics)

**Agent integration:**
- Agent retrieves learner profile, recent vocabulary, and due cards to build Spanish coaching context
- Adaptive difficulty: queries `getSpanishAdaptiveContext()` for retention stats and lapse rate, adjusts guidance (consolidation vs advancement)
- Language direction: Spanish-primary with English/Dutch woven in for warmth and clarification
- Vocabulary logged automatically during conversations when new words are introduced

**Import verbs:**
```bash
pnpm import:verbs   # Downloads CSV from GitHub, bulk inserts into spanish_verbs
```

### Spanish Learning Observability

Three-tier system for evaluating Spanish tutor effectiveness. Interface-agnostic: analytics layer in `src/spanish/` consumed by both Telegram commands and HTTP endpoints.

**Tier 1 — Retention & Effectiveness Queries** (in `queries.ts`):
- `getRetentionByInterval` — Retention rate bucketed by SRS interval (0-1d, 1-3d, 3-7d, 7-14d, 14-30d, 30d+)
- `getVocabularyFunnel` — Word counts by SRS state (new → learning → review → relearning) with median days
- `getGradeTrend` — Daily average grade over configurable window
- `getLapseRateTrend` — Daily lapse rate (grade ≤ 2) over configurable window
- `getProgressTimeSeries` — Historical `spanish_progress` snapshots
- `getRetentionByContext` — Retention grouped by `review_context` (quiz vs conversation)

**Tier 2 — Digest & Endpoints**:
- `src/spanish/analytics.ts` — Pure functions: `buildRetentionSummary`, `buildFunnelSummary`, `buildTrendSummary`, `buildAssessmentSummary`, `formatDigestText`, `formatProgressTimeSeries`
- `/digest` Telegram command — Sends formatted HTML summary of all analytics
- `GET /api/spanish/:chatId/dashboard` — JSON dashboard aggregating all analytics data
- `GET /api/spanish/:chatId/assessments` — Assessment history (both require bearer token auth)

**Tier 3 — LLM-as-Judge Assessment** (`src/spanish/assessment.ts`):
- Samples up to 20 recent user messages from `chat_messages`
- Sends to gpt-4o-mini for structured evaluation: complexity (1-5), grammar (1-5), vocabulary (1-5), code-switching ratio (0-1), overall (1-5), rationale
- Stores results in `spanish_assessments` table
- `AssessmentLlmClient` interface for dependency injection (testable without API calls)
- `/assess` Telegram command triggers evaluation and sends formatted result

**DB table**: `spanish_assessments` — stores LLM assessment results with scores, sample count, rationale, timestamp. Indexed on `(chat_id, assessed_at DESC)`.

### Oura Ring Integration

Hourly sync from Oura API v2 into PostgreSQL, giving the Telegram agent access to biometrics. Design: `specs/oura-integration-plan.md`.

**6 MCP tools:**
- `get_oura_summary` — Single-day health snapshot: sleep score/duration/stages, readiness, activity/steps, stress, HRV, workouts. Defaults to today.
- `get_oura_weekly` — 7-day overview: daily scores, averages, best/worst days, total steps/workouts.
- `get_oura_trends` — N-day trend analysis: rolling averages (7/14/30-day), trend direction, day-of-week patterns. Optional metric filter.
- `get_oura_analysis` — Multi-type analysis: `sleep_quality` (debt, regularity, stage ratios), `anomalies` (IQR + Z-score outliers), `hrv_trend` (rolling averages, recovery patterns), `temperature` (deviation trends, flagged days), `best_sleep` (activity/workout/day-of-week correlations).
- `oura_compare_periods` — Side-by-side metrics between two date ranges with % changes.
- `oura_correlate` — Pearson correlation between any two metrics (r, p-value, strength).

**DB tables (8):**
- `oura_sync_state` — Last sync date per endpoint
- `oura_sync_runs` — Audit trail: start/end time, records synced, errors
- `oura_daily_sleep` — Scores + contributors JSONB + raw_json
- `oura_sleep_sessions` — Per-session: stages, HR, HRV, efficiency
- `oura_daily_readiness` — Recovery score, temperature deviation
- `oura_daily_activity` — Steps, calories, intensity breakdown
- `oura_daily_stress` — Stress/recovery seconds, day summary
- `oura_workouts` — Activity type, duration, HR, distance
- `daily_health_snapshot` — SQL view joining all domains for cross-metric queries

**Sync mechanism:**
- In-process `setInterval` in HTTP server, starts when `OURA_ACCESS_TOKEN` is set
- PG advisory lock prevents overlapping runs
- Initial run: 30-day backfill. Hourly runs: 3-day rolling lookback
- 6 endpoints fetched in parallel, all upserts idempotent (`ON CONFLICT DO UPDATE`)
- Manual backfill: `pnpm sync:oura [--days 90]`

**Context injection:**
- `buildOuraContextPrompt()` auto-injects today's biometrics into the Telegram agent system prompt
- Includes sleep score/duration/stages/efficiency, readiness, activity, HRV, steps, stress, bedtime/waketime

**Config:**
```
OURA_ACCESS_TOKEN          — Personal access token from cloud.ouraring.com
OURA_SYNC_INTERVAL_MINUTES — default 60
OURA_SYNC_LOOKBACK_DAYS    — default 3
```

### Insight Engine

Background worker that surfaces non-obvious connections across data and delivers them as Telegram notifications. Runs daily on a timer (like Oura sync), uses advisory lock to prevent concurrent runs. Design: `specs/insight-engine.md`.

**3 insight types:**
- `temporal_echo` — Semantically similar entries from the same calendar date (MM-DD) in previous years. Cosine similarity threshold 0.75.
- `biometric_correlation` — When Oura data shows anomalies (low sleep, low readiness, low HRV, short sleep duration), surfaces nearby journal entries for context.
- `stale_todo` — Active todos not updated in 7+ days, ordered by importance. Resurfaces weekly via week-bracket dedup hash.

**DB table:** `insights` — stores generated insights with type, content_hash (dedup), title, body, relevance score, JSONB metadata, notified_at timestamp.

**Dedup:** SHA-256 content hash checked against configurable window (default 30 days). Daily notification cap (default 3).

**Config:**
```
INSIGHT_ENGINE_INTERVAL_HOURS    — default 24
INSIGHT_ENGINE_MAX_PER_DAY       — default 3
INSIGHT_ENGINE_DEDUP_WINDOW_DAYS — default 30
```

## HTTP REST API

Beyond MCP transport and Telegram webhook, the HTTP server (`src/transports/http.ts`) exposes REST endpoints authenticated via bearer token (`MCP_SECRET`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/weights` | GET | List weight history (`from`, `to`, `limit`, `offset`) |
| `/api/weights/:date` | PUT | Upsert daily weight (`{ weight_kg }`) |
| `/api/weights/:date` | DELETE | Delete daily weight by date |
| `/api/weights/patterns` | GET | Weight trend/consistency/plateau summary |
| `/api/metrics` | POST | Legacy metrics ingestion (`{ date, weight_kg }`) |
| `/api/activity` | GET | Recent activity logs (supports `limit`, `since`, `tool`) |
| `/api/activity/:id` | GET | Single activity log by ID |
| `/api/spanish/:chatId/dashboard` | GET | Aggregated Spanish learning analytics (retention, funnel, trends, assessment) |
| `/api/spanish/:chatId/assessments` | GET | Spanish assessment history |
| `/api/artifacts` | GET | List/search artifacts. Without `q`: `{ items, total }`; with `q`: array (RRF). Filters: `kind`, `tags`, `tags_mode`, `limit`, `offset` |
| `/api/artifacts/tags` | GET | Artifact tag counts for filter pills |
| `/api/artifacts/titles` | GET | Lightweight artifact titles for quick switcher/link picker |
| `/api/artifacts/graph` | GET | Graph payload (`nodes`, `edges`) for graph view |
| `/api/artifacts/:id/related` | GET | Related artifacts (`semantic` + `explicit` links/backlinks) |
| `/api/artifacts/:id` | GET | Get full artifact with sources and version |
| `/api/artifacts` | POST | Create artifact (`{ kind, title, body, tags?, source_entry_uuids? }`) |
| `/api/artifacts/:id` | PUT | Update artifact with optimistic locking (`expected_version`, 409 on conflict) |
| `/api/artifacts/:id` | DELETE | Delete artifact and cascade source links |
| `/api/entries/search` | GET | Lightweight entry search for source picker (`{ uuid, created_at, preview }`) |
| `/api/content/search` | GET | Unified search across entries + artifacts |
| `/api/todos` | GET | List todos. Filters: `status`, `urgent`, `important`, `parent_id`, `focus_only`, `include_children`, `limit`, `offset`. Returns `{ items, total }` |
| `/api/todos/focus` | GET | Get current focus todo |
| `/api/todos/:id` | GET | Get single todo with children |
| `/api/todos` | POST | Create todo (`{ title, status?, next_step?, body?, tags?, urgent?, important?, parent_id? }`) |
| `/api/todos/:id` | PUT | Update todo (`{ title?, status?, next_step?, body?, tags?, urgent?, important? }`) |
| `/api/todos/:id/complete` | POST | Complete todo (sets done + completed_at + clears focus) |
| `/api/todos/focus` | POST | Set focus `{ id }` or clear `{ clear: true }` |
| `/api/todos/:id` | DELETE | Delete todo |
| `/api/telegram` | POST | Telegram webhook endpoint (validated via `X-Telegram-Bot-Api-Secret-Token`) |

## Spec Planning Workflow

Automated multi-LLM spec planning. Claude drafts specs with codebase context, Codex reviews with fresh eyes, and they iterate to convergence.

```bash
pnpm spec:plan <name> <description>
```

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Write/update/delete tools (this server is read-only for journal entries; artifacts have CRUD via REST API)
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)
- Auto-purge of compacted messages (function exists in `queries.ts`, not wired up)

See `specs/*.md` files marked `[Stub]` or `[Planned]` for upcoming features.
