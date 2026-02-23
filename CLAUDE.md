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
3. `vitest run --coverage` — Unit + integration tests with 100% coverage enforcement

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
    log-weight.ts   — Daily weight logging (reuses upsertDailyMetric).
    conjugate-verb.ts — Spanish verb conjugation lookup from reference DB.
    log-vocabulary.ts — Track Spanish vocabulary with SRS state per chat.
    spanish-quiz.ts — Spaced-repetition quiz: get due cards, record reviews, stats.
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
  deploy-smoke.ts   — Post-deploy smoke test.
  telegram-setup.ts — Set/check/delete Telegram webhook.
specs/
  schema.sql        — Canonical DB schema.
  tools.spec.ts     — Tool contracts: params, types, descriptions, examples.
  spanish-learning.md — Spanish learning infrastructure design (phases, tables, tools).
  telegram-chatbot-plan.md — Original design for Telegram chatbot with pattern memory.
  telegram-personality-plan.md — Soul personality system design (one evolving identity).
  self-healing-organism.md — Autonomous quality loop design (pulse checks, soul repairs).
  episodic-memory.md — Implemented episodic memory + hardening notes (fact + event).
  ltm-research.md   — Evidence-based research on long-term memory architecture.
  aws-sst-migration-plan.md — Future AWS/SST migration plan (not implemented).
  web-app.spec.md   — Future web dashboard spec (not implemented).
  fixtures/
    seed.ts         — Test data with pre-computed embeddings for determinism.
packages/
  shared/           — @espejo/shared workspace. Shared TypeScript types between MCP server and web frontend.
web/                — SvelteKit frontend (@espejo/web workspace). Early/partial — not production-ready.
  src/routes/       — Page components (entries list, detail view).
  src/lib/server/   — Server-side DB queries.
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

**Unit tests** (`tests/tools/`, `tests/formatters/`):
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

### Connecting to dev database

```
Host:     localhost
Port:     5434
Database: journal_dev
User:     dev
Password: dev
```

Or as a connection string: `postgresql://dev:dev@localhost:5434/journal_dev`

**Note:** Some tools (TablePlus, pgAdmin, psql) need each field entered separately. If you get `database "dev" does not exist`, the tool is using the username as the database name — make sure to specify `journal_dev` explicitly.

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
2. **test** (needs lint) — `pnpm test -- --coverage` (unit + integration + 100% coverage)

Integration tests use Docker Compose inside CI (same as local). The vitest `globalSetup` starts the test DB container automatically. Docker is pre-installed on GitHub's `ubuntu-latest` runners.

### Coverage

100% line/function/branch/statement coverage enforced via `@vitest/coverage-v8`. Thresholds configured in `vitest.config.ts`. `pnpm check` runs coverage locally too (`pnpm test:coverage`).

Files excluded from coverage via config: `src/index.ts` (entry point) and `src/db/client.ts` (module-level pool). Defensive branches in `src/db/queries.ts` and `src/server.ts` use `/* v8 ignore next */` pragmas.

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
- Queries the journal using all 11 MCP tools via tool_use loop (journal search/retrieval + Spanish learning + weight logging)
- Spanish language tutor: conducts conversations primarily in Spanish, corrects conjugation mistakes, tracks vocabulary with FSRS spaced repetition, and adapts difficulty based on real review performance
- Logs weight via natural language ("I weighed in at 76.5 today")
- Accepts text, voice, photo, and document messages (with OCR/text extraction for media)
- Voice messages transcribed via OpenAI Whisper
- Optionally responds with Telegram voice notes using adaptive/fallback rules
- Extracts patterns from conversations during compaction — the bot's long-term memory
- Logs activity per agent run (memories retrieved, tool calls with full results) in `activity_logs` table

**Commands:**
- `/evening` — Evening review mode: guided journaling session with somatic check-ins, system assessments (escalera, boundaries, attachment), and Spanish-primary conversation
- `/morning` — Morning flow mode: free-flow morning journal session
- `/compact` — Force pattern extraction from recent conversation (useful for testing, or when you want the bot to learn from a short conversation without waiting)
- `/digest` — Spanish learning summary: vocabulary stats, retention rates, grade/lapse trends, adaptive status tier, latest assessment
- `/assess` — Trigger LLM-as-judge evaluation of recent Spanish conversation quality (complexity, grammar, vocabulary, code-switching ratio)

**Pattern memory:**
- 9 pattern kinds with typed decay scoring: behavior, emotion, belief, goal, preference, temporal, causal, fact, event
- Compaction triggers: size-based (>48k chars) OR time-based (12+ hours since last, 10+ messages)
- Dedup: canonical hash (exact match) + ANN embedding similarity (0.82+ threshold)
- Retrieval: semantic search → MMR reranking → budget cap (2000 tokens) → injected into system prompt
- Stale event handling: notify-only during compaction (`Memory note`) — no automatic pruning/deletion
- DB tables: `chat_messages`, `patterns`, `pattern_observations`, `pattern_relations`, `pattern_aliases`, `pattern_entries`, `api_usage`, `memory_retrieval_logs`
- Provenance fields: `patterns.source_type/source_id`, `pattern_observations.source_type/source_id`

Episodic memory (`fact` and `event`) is implemented. See `specs/episodic-memory.md`.

### Soul Personality System

One evolving personality that grows through interaction. Design: `specs/telegram-personality-plan.md`.

- `chat_soul_state` table: identity summary, relational commitments, tone signature, growth notes, version counter
- Soul state evolves during compaction — LLM analyzes conversation and proposes updates
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
- `GET /api/activity-logs/:chatId` — Recent activity logs for a chat
- `GET /api/activity-logs/:chatId/:id` — Single activity log by ID

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

## HTTP REST API

Beyond MCP transport and Telegram webhook, the HTTP server (`src/transports/http.ts`) exposes REST endpoints authenticated via bearer token (`MCP_SECRET`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/activity-logs/:chatId` | GET | Recent activity logs (memories, tool calls, cost) |
| `/api/activity-logs/:chatId/:id` | GET | Single activity log by ID |
| `/api/spanish/:chatId/dashboard` | GET | Aggregated Spanish learning analytics (retention, funnel, trends, assessment) |
| `/api/spanish/:chatId/assessments` | GET | Spanish assessment history |
| `/api/weight` | POST | Log daily weight (`{ weight_kg, date? }`) |
| `/api/telegram` | POST | Telegram webhook endpoint (validated via `X-Telegram-Bot-Api-Secret-Token`) |

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Oura Ring data correlation
- Write/update/delete tools (this server is read-only for journal entries)
- Web UI or dashboard (spec at `specs/web-app.spec.md`, early SvelteKit scaffold in `web/` — not production-ready)
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)
- Auto-purge of compacted messages (function exists in `queries.ts`, not wired up)
