# espejo

A personal AI journal system built on PostgreSQL + pgvector. Started as an MCP server for semantic search over Day One exports, then grew into a Telegram chatbot with pattern-based long-term memory, an evolving personality, and a Spanish language tutor.

*Espejo* means *mirror* in Spanish.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Clients                                        │
│                                                                             │
│   ┌──────────────┐   ┌──────────────────┐   ┌───────────────────────────┐  │
│   │ Claude Desktop│   │ Telegram Chat    │   │ HTTP REST API             │  │
│   │ (MCP stdio)  │   │ (webhook)        │   │ (bearer token auth)       │  │
│   └──────┬───────┘   └────────┬─────────┘   └─────────────┬─────────────┘  │
└──────────┼────────────────────┼────────────────────────────┼────────────────┘
           │                    │                             │
           ▼                    ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          espejo (Node.js / Express)                         │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                        Transports                                   │   │
│   │   MCP stdio  ·  MCP StreamableHTTP  ·  Telegram webhook  ·  REST   │   │
│   └─────────────────────────────┬───────────────────────────────────────┘   │
│                                 │                                           │
│   ┌─────────────────────────────┼───────────────────────────────────────┐   │
│   │                        Core Services                                │   │
│   │                             │                                       │   │
│   │   ┌─────────────────────────┼──────────────────────────────────┐    │   │
│   │   │              MCP Tools (spec-driven)                       │    │   │
│   │   │                                                            │    │   │
│   │   │  Journal:  search · get_entry · get_entries_by_date        │    │   │
│   │   │           on_this_day · find_similar · list_tags            │    │   │
│   │   │           entry_stats                                      │    │   │
│   │   │                                                            │    │   │
│   │   │  Health:   get_oura_summary · get_oura_weekly              │    │   │
│   │   │           get_oura_trends                                  │    │   │
│   │   │           get_oura_analysis · oura_compare_periods         │    │   │
│   │   │           oura_correlate                                   │    │   │
│   │   │                                                            │    │   │
│   │   │  Spanish:  conjugate_verb · log_vocabulary · spanish_quiz  │    │   │
│   │   │                                                            │    │   │
│   │   │  Memory:   remember · save_chat · recall · reflect         │    │   │
│   │   │                                                            │    │   │
│   │   │  Artifacts: get_artifact · list_artifacts                  │    │   │
│   │   │             search_artifacts · search_content              │    │   │
│   │   │                                                            │    │   │
│   │   │  Todos:    list_todos · create_todo · update_todo          │    │   │
│   │   │            complete_todo · set_todo_focus                  │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                     │   │
│   │   ┌────────────────────────────────────────────────────────────┐    │   │
│   │   │              Telegram Agent                                │    │   │
│   │   │                                                            │    │   │
│   │   │  Conversational AI  ·  Pattern memory (3 kinds)            │    │   │
│   │   │  Soul personality   ·  Self-healing quality loop           │    │   │
│   │   │  Voice (Whisper/TTS) · Photo/document processing           │    │   │
│   │   │  Spanish tutoring   ·  Spaced repetition (FSRS)           │    │   │
│   │   │  Evening review     ·  Morning journal                    │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                     │   │
│   │   ┌────────────────────────────────────────────────────────────┐    │   │
│   │   │              Oura Ring Sync (hourly)                       │    │   │
│   │   │                                                            │    │   │
│   │   │  PG advisory lock  ·  6 endpoints in parallel              │    │   │
│   │   │  30-day backfill   ·  3-day rolling lookback               │    │   │
│   │   │  Idempotent upserts (ON CONFLICT DO UPDATE)                │    │   │
│   │   └────────────────────────────────────────────────────────────┘    │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                 │                                           │
│                    ┌────────────┼────────────┐                              │
│                    ▼            ▼            ▼                              │
│             ┌───────────┐ ┌─────────┐ ┌──────────┐                         │
│             │ PostgreSQL│ │ OpenAI  │ │Anthropic │                         │
│             │ + pgvector│ │ embed / │ │ Claude   │                         │
│             │ + tsvector│ │ Whisper │ │ (agent)  │                         │
│             └───────────┘ │ / TTS   │ └──────────┘                         │
│                           └─────────┘                                      │
│                                                                             │
│             ┌───────────┐ ┌───────────┐                                    │
│             │Cloudflare │ │ Oura API  │                                    │
│             │ R2 (media)│ │ (v2 REST) │                                    │
│             └───────────┘ └───────────┘                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## How It Evolved

The project was built in two weeks (Feb 9–24, 2026). Each phase layered on the last.

```
Phase 0 ─── MCP Server ──────────────── Hybrid RRF search over 2,836 journal entries
  │                                      7 tools: search, get, date, similar, tags, stats
  │
Phase 1 ─── Telegram Chatbot ────────── Webhook handler, agent loop, pattern-based memory
  │                                      v1 memory extraction during compaction
  │
Phase 2 ─── Soul Personality ────────── One evolving identity per chat
  │                                      State snapshots, version control, audit trail
  │
Phase 3 ─── Self-Healing Loop ───────── Autonomous quality monitoring
  │                                      Pulse checks, drift detection, soul repairs
  │
Phase 4 ─── Episodic Memory ─────────── v1 fact/event memory additions
  │                                      Provenance tracking, retrieval logs
  │
Phase 5 ─── Spanish Learning ────────── Verb conjugations, vocabulary tracking
  │                                      FSRS spaced repetition, adaptive difficulty
  │                                      LLM-as-judge assessment, analytics dashboard
  │
Phase 6 ─── Observability ───────────── Activity logs, cost tracking
  │                                      REST API endpoints, Spanish digest
  │
Phase 7 ─── Oura Ring ──────────────── Hourly sync from Oura API → PostgreSQL
                                         6 tools: summary, weekly, trends,
                                         analysis, compare periods, correlate
                                         1100-line analysis module (pure functions)
  │
Phase 8 ─── Memory v2 ──────────────── 3 memory kinds (identity/preference/goal),
                                         4 MCP memory tools, hybrid recall,
                                         decoupled compaction, global soul state
  │
Phase 9 ─── Web Journaling ────────── Entry CRUD with optimistic locking,
                                         media upload to R2, entry templates,
                                         source/version tracking, async embeddings
```

Design documents for each phase live in `specs/`:

| Phase | Spec | Status |
|-------|------|--------|
| 0 | `specs/tools.spec.ts` | Deployed |
| 1 | `specs/telegram-chatbot-plan.md` | Deployed |
| 2 | `specs/telegram-personality-plan.md` | Deployed |
| 3 | `specs/self-healing-organism.md` | Deployed |
| 4 | `specs/episodic-memory.md` | Deployed |
| 5 | `specs/spanish-learning.md` | Deployed |
| 6 | (observability — no dedicated spec) | Deployed |
| 7 | `specs/oura-integration-plan.md` | Deployed |
| 8 | `specs/memory-v2.md` | Deployed |
| — | `specs/ltm-research.md` | Research |
| — | `specs/web-app.spec.md` | Deployed |
| 9 | `specs/web-journaling.md` | Deployed |
| — | `specs/aws-sst-migration-plan.md` | Planned |

## Why This Exists

Day One has an MCP integration that lets LLMs read and write journal entries. In practice, it's limited:

- **Multi-term search is broken** — querying for more than one term frequently returns zero results
- **No semantic search** — you can ask "what did I write on December 5th" but not "entries where I was processing difficult emotions about work"
- **No fuzzy matching** — typos or paraphrased concepts return nothing
- **No cross-entry analysis** — no way to find similar entries, discover recurring themes, or correlate patterns over time

This project exports the full Day One journal into PostgreSQL with pgvector, then puts an MCP server in front of it that supports hybrid semantic + keyword search, entry similarity, and structured queries that actually work.

## Search: Hybrid RRF

The core retrieval runs two parallel searches and merges with Reciprocal Rank Fusion:

1. **Semantic** — embed the query via OpenAI `text-embedding-3-small` → pgvector cosine similarity (`<=>`)
2. **BM25** — full-text search via tsvector (`@@` with `ts_rank`)
3. **Merge** — `score = 1/(60 + rank_semantic) + 1/(60 + rank_bm25)`

Both pull top-20 candidates. Optional filters (date range, tags, city) apply as WHERE clauses in both retrievals.

In practice:
- `"Barcelona morning routine"` — BM25 finds "Barcelona", vectors find "morning routine" entries
- `"feeling overwhelmed by project management"` — vectors find entries about work stress even without those exact words
- `"nicotine dopamine"` — BM25 matches exact terms + vectors find semantically related entries about stimulant effects

### Dataset

| Metric | Value |
|--------|-------|
| Total entries | 2,836 |
| Total tokens | ~5.8M |
| Median tokens/entry | 1,963 |
| Entries with location | 2,625 |
| Entries with weather | 2,521 |
| Entries with tags | 1,510 |
| Photos | 1,354 across 832 entries |

Every entry fits in a single embedding (max ~8K tokens). No chunking needed.

## Tools

### Journal Retrieval (7)

| Tool | Description |
|------|-------------|
| `search_entries` | Hybrid RRF search with optional date, tag, city, starred filters |
| `get_entry` | Full entry by UUID with all metadata |
| `get_entries_by_date` | Entries in a date range, chronologically ordered |
| `on_this_day` | Entries from a specific MM-DD across all years |
| `find_similar` | Entries semantically similar to a given entry |
| `list_tags` | All tags with usage counts |
| `entry_stats` | Writing frequency, word counts, trends |

### Health & Biometrics (6 MCP tools + web weight UI)

| Tool | Description |
|------|-------------|
| `get_oura_summary` | Single-day health snapshot: sleep, readiness, activity, HRV, stress, workouts |
| `get_oura_weekly` | 7-day overview with daily scores, averages, best/worst days |
| `get_oura_trends` | N-day trend analysis with rolling averages and day-of-week patterns |
| `get_oura_analysis` | Multi-type analysis: sleep quality, anomalies, HRV trends, temperature, best sleep conditions |
| `oura_compare_periods` | Side-by-side metrics comparison between two date ranges |
| `oura_correlate` | Pearson correlation between any two health metrics |

Weight logging moved to the web app (`/weight`) with history, charting, and pattern metrics. API endpoints: `GET /api/weights`, `PUT/DELETE /api/weights/:date`, `GET /api/weights/patterns`.

### Spanish Learning (3)

| Tool | Description |
|------|-------------|
| `conjugate_verb` | Spanish verb conjugation lookup (~11k forms from Fred Jehle database) |
| `log_vocabulary` | Track vocabulary per chat with FSRS spaced repetition state |
| `spanish_quiz` | Get due cards, record reviews (FSRS grades 1–4), view stats |

Tool contracts are defined in `specs/tools.spec.ts` — the single source of truth for params, types, descriptions, and examples. Server registration, tests, and documentation all derive from it.

## Knowledge Base Web App (March 2026)

Newly added/updated features:
- `note` artifact kind across schema, API validation, tool specs, and UI badges/filters
- Todo system (`todos` table, CRUD API, `/todos` UI routes, status workflow)
- Tag filtering in artifact list (multi-tag AND semantics via `tags_mode=all`)
- Global quick switcher (`Cmd+K` / `Ctrl+K`) with fuzzy title navigation
- Semantic links + backlinks (`[[Title]]` detection + `artifact_links` table + related panel)
- Graph view (semantic + explicit + shared-tag + shared-source edges)
- Web journaling: entry CRUD with optimistic locking, media upload (R2), entry templates, async embeddings

Primary docs:
- `specs/web-feature-rollout.md` (full implementation and verification checklist)
- `specs/web-app.spec.md` (current web app behavior + API contract)
- `specs/todos.md` and `specs/knowledge-artifacts.md` (domain specs)

Quick validation:
```bash
pnpm check
cd web && npx vite build
cd web && pnpm e2e
```

## Telegram Chatbot

An optional conversational interface that wraps the MCP tool set in a Telegram bot with long-term memory and an evolving personality. Enabled when `TELEGRAM_BOT_TOKEN` is set.

### What It Does

- Queries the journal via natural language using all MCP tools
- Oura Ring biometrics auto-injected into context for evening reviews and morning flows
- Accepts text, voice, photo, and document messages
- Voice transcription via Whisper, optional TTS replies
- Spanish language tutoring with adaptive difficulty based on real review performance
- Weight logging via natural language ("I weighed in at 76.5 today")

### Pattern Memory

Conversations are short-term. Patterns are long-term memory.

Memory v2 is implemented:

- **3 memory kinds**: `identity`, `preference`, `goal`
- **Intentional writes**: `remember` (single memory) and `save_chat` (batch extraction)
- **Compaction is context management only**: summarize + mark compacted (no extraction side effects)
- **Dedup pipeline**: canonical hash + embedding similarity
- **Retrieval**: hybrid semantic + text search merged with RRF and score floors
- **Maintenance**: consolidation (`superseded`), stale review, and active cap enforcement

### Soul Personality

One evolving identity per chat — not a fixed persona, but a personality that grows through interaction.

- **Identity summary** — who the bot is becoming in this relationship
- **Relational commitments** — how it should show up
- **Tone signature** — stable style cues
- **Growth notes** — what changed recently
- **Version counter + audit trail** — every mutation is logged with a reason

The soul evolves in the main agent loop with guardrails, and the pulse system can apply additional repairs. Guardrails prevent hard personality jumps.

### Self-Healing Quality Loop

The bot monitors its own quality and adjusts autonomously:

1. **Signal collection** — tracks user reactions: `felt_personal`, `felt_generic`, `correction`, `positive_reaction`
2. **Pulse checks** — periodic diagnosis: `healthy`, `drifting`, `stale`, `overcorrecting`
3. **Repairs** — `diagnoseQuality()` → `proposeSoulRepairs()` → `applySoulRepairs()`, max 1 repair per 24 hours

### Spanish Tutoring

The bot conducts conversations primarily in Spanish, corrects conjugation mistakes, tracks vocabulary with FSRS spaced repetition, and adapts difficulty based on real review performance.

Observability across three tiers:

- **Tier 1** — Retention queries: by interval, vocabulary funnel, grade trends, lapse rate
- **Tier 2** — `/digest` command and `GET /api/spanish/:chatId/dashboard` endpoint
- **Tier 3** — LLM-as-judge assessment (`/assess` command): evaluates complexity, grammar, vocabulary, code-switching ratio

### Commands

| Command | Description |
|---------|-------------|
| `/morning` | Free-flow morning journal session |
| `/evening` | Guided evening review with somatic check-ins |
| `/compact` | Force compaction summary from recent conversation |
| `/digest` | Spanish learning summary: vocab stats, retention, trends |
| `/assess` | LLM-as-judge evaluation of recent Spanish conversation quality |

## REST API

Authenticated via `MCP_SECRET` bearer token:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/weights` | GET | List weight history (`from`, `to`, `limit`, `offset`) |
| `/api/weights/:date` | PUT | Upsert daily weight (`{ weight_kg }`) |
| `/api/weights/:date` | DELETE | Delete daily weight value |
| `/api/weights/patterns` | GET | Weight trend/consistency pattern summary |
| `/api/metrics` | POST | Legacy metrics ingestion endpoint (`{ date, weight_kg }`) |
| `/api/activity` | GET | Recent activity logs (`limit`, `since`, `tool`) |
| `/api/activity/:id` | GET | Single activity log |
| `/api/spanish/:chatId/dashboard` | GET | Aggregated Spanish learning analytics |
| `/api/spanish/:chatId/assessments` | GET | Spanish assessment history |
| `/api/artifacts` | GET/POST | List/search artifacts or create artifact |
| `/api/artifacts/:id` | GET/PUT/DELETE | Get/update/delete artifact |
| `/api/artifacts/tags` | GET | Artifact tag counts |
| `/api/artifacts/titles` | GET | Lightweight artifact titles for quick switcher |
| `/api/artifacts/:id/related` | GET | Semantic + explicit related artifacts |
| `/api/artifacts/graph` | GET | Graph payload (`nodes`, `edges`) |
| `/api/entries/search` | GET | Entry search for source picker |
| `/api/content/search` | GET | Unified search across entries + artifacts |
| `/api/todos` | GET/POST | List todos or create todo |
| `/api/todos/:id` | GET/PUT/DELETE | Get/update/delete todo |
| `/api/entries` | GET/POST | List entries (with filters) or create entry |
| `/api/entries/:uuid` | GET/PUT/DELETE | Get/update/delete entry |
| `/api/entries/:uuid/media` | POST | Upload image media to entry |
| `/api/media/:id` | DELETE | Delete media |
| `/api/templates` | GET/POST | List or create entry templates |
| `/api/templates/:id` | GET/PUT/DELETE | Get/update/delete template |

## Development

### Prerequisites

- Node.js (see `.nvmrc`)
- pnpm
- Docker

### Setup

```bash
pnpm install
docker compose up -d              # Dev PostgreSQL on port 5434
pnpm migrate                      # Apply schema
pnpm sync                         # Sync from DayOne.sqlite (set DAYONE_SQLITE_PATH)
pnpm embed                        # Generate embeddings via OpenAI
pnpm dev                          # Start MCP server (stdio)
```

### Development Loop

After every code change:

```bash
pnpm check    # typecheck → lint → test + coverage thresholds
```

This runs `tsc --noEmit`, ESLint, and Vitest with coverage enforcement in order, short-circuiting on first failure. Do not commit until it passes.

### Testing

Two tiers:

- **Unit tests** (`tests/tools/`, `tests/formatters/`, `tests/oura/`, `tests/utils/`) — no database, fast, test param validation and spec conformance
- **Integration tests** (`tests/integration/`) — Docker Compose auto-starts a test PostgreSQL on port 5433 (tmpfs-backed, RAM only)

Fixtures include pre-computed 1536-dimension embedding vectors. No OpenAI calls during tests. Coverage policy: global `95/95/90/95` (`lines/functions/branches/statements`) with 100% enforcement on critical modules (`src/db/queries.ts`, `src/transports/http.ts`, `src/tools/search.ts`, `src/oura/analysis.ts`).

### Environment Separation

| Environment | Database | Port | Notes |
|-------------|----------|------|-------|
| Development | `journal_dev` | 5434 | Full journal data, persistent volume |
| Test | `journal_test` | 5433 | Fixture data only, RAM-backed |
| Production | Railway PG | — | `DATABASE_URL` injected by Railway |

## Deployment

Deployed to Railway. Multi-stage Dockerfile: TypeScript build → slim Node.js runtime.

**Required env vars:**
- `DATABASE_URL` — PostgreSQL with pgvector
- `OPENAI_API_KEY` — query-time embedding
- `NODE_ENV=production`

**Optional (Telegram):**
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`
- `ANTHROPIC_API_KEY` (when `TELEGRAM_LLM_PROVIDER=anthropic`)

**Optional (Oura Ring):**
- `OURA_ACCESS_TOKEN` — personal access token from cloud.ouraring.com
- `OURA_SYNC_INTERVAL_MINUTES` — sync frequency (default: 60)
- `OURA_SYNC_LOOKBACK_DAYS` — rolling lookback window (default: 3)

**Optional (media):**
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

Supports both stdio transport (Claude Desktop) and HTTP/SSE transport (remote deployment).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js, TypeScript (strict) |
| MCP | `@modelcontextprotocol/sdk` |
| Database | PostgreSQL 16 + pgvector + tsvector + pg_trgm |
| Embeddings | OpenAI `text-embedding-3-small` |
| Agent | Anthropic Claude (configurable: OpenAI) |
| Voice | OpenAI Whisper (STT) + TTS |
| HTTP | Express 5 |
| Media | Cloudflare R2 (S3-compatible) |
| Validation | Zod |
| Testing | Vitest + Docker Compose |
| CI | GitHub Actions (lint → test + strict coverage thresholds) |
| Deploy | Railway |

## License

MIT
