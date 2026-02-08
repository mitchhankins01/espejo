# espejo-mcp

MCP server for semantic journal search over Day One exports in PostgreSQL + pgvector.

## Development Loop

After EVERY code change, run:

```
pnpm check
```

This runs in order, short-circuiting on first failure:

1. `tsc --noEmit` — Type errors mean interfaces don't match the spec
2. `eslint` — Style violations, unused imports, dead code
3. `vitest run` — Unit + integration tests

**Do not commit or move on until `pnpm check` passes.**

If a test fails, read the full error output. Test names map to specs in `specs/tools.spec.ts`. Custom assertion helpers in `tests/helpers/assertions.ts` include `Hint:` messages explaining what to fix.

## Quick Start

```bash
pnpm install
docker compose up -d                    # Dev PG on port 5432
pnpm migrate                            # Apply schema
pnpm import -- path/to/Journal.json     # Import Day One export
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
  formatters/
    entry.ts        — Raw DB row → human-readable string with emoji, metadata.
    search-results.ts — Ranked results with RRF score context.
scripts/
  import-journal.ts — Day One JSON → PG. Idempotent (ON CONFLICT DO UPDATE).
  embed-entries.ts  — Batch embed all entries missing embeddings.
  migrate.ts        — Runs SQL files, tracks applied migrations in _migrations table.
specs/
  schema.sql        — Canonical DB schema.
  tools.spec.ts     — Tool contracts: params, types, descriptions, examples.
  fixtures/
    sample-export.json — Small realistic Day One export for import script tests.
    seed.ts         — Test data with pre-computed embeddings for determinism.
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

Both retrievals pull top-20 candidates. The merge produces the final ranked list. Optional filters (date range, tags, city, starred) are applied as WHERE clauses in BOTH retrievals to keep results consistent.

The query must embed the search string at runtime using the same model used for indexing (`text-embedding-3-small`).

### Config Fails Fast

`src/config.ts` throws on startup if `DATABASE_URL` is empty in production. Don't let the server start and fail on first query — that's harder to debug.

### Formatters Are the Presentation Layer

Tools return raw data from queries. Formatters turn DB rows into human-readable MCP responses. A formatted entry looks like:

```
📅 November 15, 2025 — Barcelona, Spain
🏷️ morning-review, nicotine
⭐ Starred

Woke up feeling depleted. The nicotine yesterday definitely crashed
my dopamine baseline...

---
☁️ Partly Cloudy, 18°C | 📍 Eixample
```

Keep formatters pure functions with no side effects.

### Tags Are Normalized

Tags live in a separate `tags` table with a junction table `entry_tags`. This enables efficient tag-based queries and `list_tags` aggregation. When importing, upsert tags (`ON CONFLICT (name) DO NOTHING`) and create junction records.

### Import Is Idempotent

`scripts/import-journal.ts` uses `ON CONFLICT (uuid) DO UPDATE` so re-running it updates existing entries instead of failing on duplicates. This means you can re-export from Day One and re-import without manual cleanup.

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
- Test DB runs on port 5433 to avoid collision with dev DB on 5432

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
| Development | `journal_dev` | 5432 | `.env.development` | Full journal data, persistent volume |
| Test | `journal_test` | 5433 | `.env.test` | Fixture data only, tmpfs (RAM), auto-managed |
| Production | Railway PG | — | Railway env vars | `DATABASE_URL` injected by Railway |

The `src/config.ts` module selects the right config based on `NODE_ENV`. Default is `development`.

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
pnpm import -- path/to/Journal.json
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

### Re-embed after model change

If you change the embedding model, re-embed everything:

```bash
pnpm embed --force   # Re-embeds all entries, not just those missing embeddings
```

## Deployment

Deployed to Railway. Mirrors the deployment pattern from [oura-ring-mcp](https://github.com/mitchhankins01/oura-ring-mcp).

**Required Railway env vars:**
- `DATABASE_URL` — auto-set by Railway PostgreSQL addon (must have pgvector extension)
- `OPENAI_API_KEY` — for query-time embedding in `search_entries`
- `NODE_ENV=production`

**Optional:**
- `PORT` — auto-set by Railway
- `MCP_SECRET` — static bearer token for Claude Desktop HTTP access

The Dockerfile is multi-stage: TypeScript build → slim Node.js runtime. The production image does not include dev dependencies, test fixtures, or Docker Compose files.

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

## What's Out of Scope

Do not implement these (they're planned future work, not part of the current build):

- Clustering analysis (HDBSCAN/k-means over embeddings)
- Oura Ring data correlation
- Write/update/delete tools (this server is read-only)
- Web UI or dashboard
- Multi-user support or auth beyond MCP SDK defaults
- Chunking strategies (entries fit in single embeddings)
