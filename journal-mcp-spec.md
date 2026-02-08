# espejo-mcp — Full Project Specification

You are scaffolding a new MCP server called `espejo-mcp`. This document contains every design decision already made. Do not re-derive or second-guess these decisions but challenge them if a better one is available — implement them as specified. If something is ambiguous, leave a `// TODO:` comment and move on.

## Reference Repo

This project mirrors the architecture of `https://github.com/mitchhankins01/oura-ring-mcp` (the Oura Ring MCP server by the same author). Match its patterns for: TypeScript style, MCP SDK usage, transport setup (stdio + HTTP), tool registration, formatting conventions, pnpm scripts, vitest config, Railway deployment, and CLAUDE.md structure. Clone that repo and study it before writing any code.

## What This Project Does

An MCP server that provides semantic and structured search over Day One journal exports stored in PostgreSQL with pgvector. It replaces Day One's native MCP (which has limited search — multi-term queries return 0 results, no fuzzy/semantic search) with a self-hosted solution supporting:

- Hybrid search using Reciprocal Rank Fusion (BM25 full-text + vector cosine similarity)
- Structured queries (by date, tags, location, etc.)
- Semantic discovery ("entries about feeling overwhelmed" even without those exact words)
- Entry similarity search

## Dataset Characteristics

- 2,836 journal entries
- Token counts: min 200, max 7,778, mean 1,949, median 1,963
- Since median is ~2K tokens, **one embedding per entry** (no chunking needed)
- Total corpus: ~5.8M tokens (cannot fit in any context window)
- Embedding cost: ~$0.12 with text-embedding-3-small

## Tech Stack

- **Runtime:** Node.js (match `.nvmrc` from oura-ring-mcp)
- **Language:** TypeScript (strict mode)
- **Package manager:** pnpm
- **Database:** PostgreSQL 16 + pgvector + pg_trgm
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Testing:** vitest
- **Deployment:** Railway (Dockerfile + `railway.json`)
- **PG Client:** `pg` (node-postgres) with `@types/pg`

---

## Repo Structure

```
journal-mcp/
├── specs/
│   ├── schema.sql                ← Canonical DB schema (source of truth)
│   ├── tools.spec.ts             ← Tool contracts with params, returns, examples
│   └── fixtures/
│       ├── sample-export.json    ← Small Day One JSON export (~10 entries, realistic format)
│       ├── seed.ts               ← Test data with pre-computed embedding vectors
│       └── expected/             ← Expected outputs per tool for snapshot tests
├── scripts/
│   ├── import-journal.ts         ← Parse Day One JSON export → PG
│   ├── embed-entries.ts          ← Generate embeddings via OpenAI, batch update PG
│   └── migrate.ts                ← Simple migration runner (SQL files + tracking table)
├── src/
│   ├── index.ts                  ← Entry point: stdio + HTTP transport
│   ├── server.ts                 ← MCP server creation + tool registration
│   ├── config.ts                 ← Env-aware config (dev/prod/test)
│   ├── db/
│   │   ├── client.ts             ← PG Pool, env-aware connection
│   │   ├── queries.ts            ← Parameterized SQL query builders
│   │   └── embeddings.ts         ← OpenAI embedding generation helper
│   ├── tools/
│   │   ├── search.ts             ← Hybrid RRF search (the main tool)
│   │   ├── get-entry.ts          ← Single entry by UUID
│   │   ├── get-entries-by-date.ts← Date range retrieval
│   │   ├── on-this-day.ts        ← Entries from MM-DD across all years
│   │   ├── find-similar.ts       ← Cosine similarity to a given entry
│   │   ├── list-tags.ts          ← All unique tags with usage counts
│   │   └── entry-stats.ts        ← Writing frequency, word count trends
│   └── formatters/
│       ├── entry.ts              ← Human-readable entry formatting
│       └── search-results.ts     ← Ranked results with relevance context
├── tests/
│   ├── setup/
│   │   ├── global-setup.ts       ← Docker compose up/down for test PG
│   │   └── per-test-setup.ts     ← Truncate + reseed between tests
│   ├── helpers/
│   │   └── assertions.ts         ← Custom assertions with actionable error hints
│   ├── tools/                    ← Unit tests per tool (spec conformance + logic)
│   ├── formatters/               ← Formatter output tests
│   └── integration/              ← Full-stack tests against real PG
├── docker-compose.yml            ← Dev DB on port 5432
├── docker-compose.test.yml       ← Test DB on port 5433 (isolated)
├── Dockerfile                    ← Multi-stage prod build
├── railway.json
├── .env.example
├── .env.development
├── .env.test
├── .gitignore
├── .nvmrc
├── CLAUDE.md                     ← Agent development instructions
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## Database Schema

This is the canonical schema. Put it in `specs/schema.sql` AND use it in docker-compose init.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE entries (
    id SERIAL PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,

    -- Content
    text TEXT,
    rich_text JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL,
    modified_at TIMESTAMPTZ,
    timezone TEXT,

    -- Entry metadata
    is_all_day BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    starred BOOLEAN DEFAULT FALSE,
    editing_time FLOAT,
    duration INT,

    -- Device info
    creation_device TEXT,
    device_model TEXT,
    device_type TEXT,
    os_name TEXT,
    os_version TEXT,

    -- Location (flattened from nested object)
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    city TEXT,
    country TEXT,
    place_name TEXT,
    admin_area TEXT,

    -- Weather (most useful fields flattened)
    temperature FLOAT,
    weather_conditions TEXT,
    humidity FLOAT,
    moon_phase FLOAT,
    sunrise TIMESTAMPTZ,
    sunset TIMESTAMPTZ,

    -- Activity
    user_activity TEXT,
    step_count INT,

    -- Template
    template_name TEXT,

    -- Source
    source_string TEXT,

    -- Vector embedding (1536 dims for text-embedding-3-small)
    embedding vector(1536),

    -- Full-text search (auto-generated)
    text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(text, ''))
    ) STORED
);

CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE entry_tags (
    entry_id INT REFERENCES entries(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE media (
    id SERIAL PRIMARY KEY,
    entry_id INT REFERENCES entries(id) ON DELETE CASCADE,
    type TEXT NOT NULL,        -- 'photo', 'video', 'audio'
    md5 TEXT,
    file_size INT,
    dimensions JSONB,
    duration FLOAT,
    camera_info JSONB,
    location JSONB
);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_entries_created ON entries(created_at);
CREATE INDEX idx_entries_text_search ON entries USING GIN(text_search);
CREATE INDEX idx_entries_embedding ON entries USING ivfflat(embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX idx_entries_trgm ON entries USING GIN(text gin_trgm_ops);
CREATE INDEX idx_entries_city ON entries(city);
CREATE INDEX idx_entries_template ON entries(template_name);
CREATE INDEX idx_tags_name ON tags(name);
```

Note: The ivfflat index with `lists = 50` is appropriate for ~3K vectors (approx sqrt(N)). If the dataset grows significantly, consider HNSW instead.

---

## Day One Export Format

The Day One JSON export has this structure. The import script must handle it:

```json
{
  "entries": [
    {
      "uuid": "ABC123...",
      "creationDate": "2019-12-02T20:27:39Z",
      "modifiedDate": "2019-12-03T10:00:00Z",
      "text": "Journal entry body text...",
      "richText": { ... },
      "creationDevice": "iPhone",
      "creationDeviceModel": "iPhone12,1",
      "creationDeviceType": "iPhone",
      "creationOSName": "iOS",
      "creationOSVersion": "14.3",
      "editingTime": 120.5,
      "isAllDay": false,
      "isPinned": false,
      "starred": false,
      "timeZone": "America/Los_Angeles",
      "duration": 0,
      "location": {
        "latitude": 41.3851,
        "longitude": 2.1734,
        "localityName": "Barcelona",
        "country": "Spain",
        "placeName": "Eixample",
        "administrativeArea": "Catalonia",
        "region": { ... }
      },
      "weather": {
        "temperatureCelsius": 18,
        "conditionsDescription": "Partly Cloudy",
        "relativeHumidity": 65,
        "moonPhase": 0.45,
        "sunriseDate": "2019-12-02T07:15:00Z",
        "sunsetDate": "2019-12-02T17:22:00Z",
        "windSpeedKPH": 12,
        "pressureMB": 1013
      },
      "userActivity": {
        "activityName": "Stationary",
        "stepCount": 8432
      },
      "tags": ["morning-review", "reflection"],
      "template": {
        "name": "5 Minute AM",
        "uuid": "...",
        ...
      },
      "photos": [
        {
          "type": "jpeg",
          "width": 4032,
          "height": 3024,
          "fileSize": 2048000,
          "md5": "abc123...",
          "cameraMake": "Apple",
          "cameraModel": "iPhone 11",
          ...
        }
      ],
      "videos": [],
      "audios": [],
      "sourceString": null
    }
  ]
}
```

Field presence varies — see the metadata section. Always use optional chaining / nullish coalescing in the import script.

---

## Tool Specifications

Put these in `specs/tools.spec.ts`. This is the source of truth — tool registration, tests, and CLAUDE.md all derive from this.

### search_entries (the core tool)

```typescript
{
  name: 'search_entries',
  description: 'Hybrid semantic + keyword search across journal entries using Reciprocal Rank Fusion (BM25 + vector cosine similarity). Supports optional date range and tag filtering.',
  params: {
    query: { type: 'string', required: true, description: 'Natural language or keyword search query' },
    date_from: { type: 'string', format: 'YYYY-MM-DD', required: false, description: 'Filter entries from this date (inclusive)' },
    date_to: { type: 'string', format: 'YYYY-MM-DD', required: false, description: 'Filter entries up to this date (inclusive)' },
    tags: { type: 'string[]', required: false, description: 'Filter to entries with any of these tags' },
    city: { type: 'string', required: false, description: 'Filter by city name' },
    starred: { type: 'boolean', required: false, description: 'Filter to starred entries only' },
    limit: { type: 'number', default: 10, max: 50, description: 'Max results to return' },
  },
}
```

**Implementation — the RRF query:**

```sql
WITH params AS (
    SELECT $1::vector AS query_embedding, plainto_tsquery('english', $2) AS ts_query
),
semantic AS (
    SELECT e.id,
           ROW_NUMBER() OVER (ORDER BY e.embedding <=> p.query_embedding) AS rank_s
    FROM entries e, params p
    WHERE e.embedding IS NOT NULL
    -- Apply optional filters here via dynamic WHERE clauses
    ORDER BY e.embedding <=> p.query_embedding
    LIMIT 20
),
fulltext AS (
    SELECT e.id,
           ROW_NUMBER() OVER (ORDER BY ts_rank(e.text_search, p.ts_query) DESC) AS rank_f
    FROM entries e, params p
    WHERE e.text_search @@ p.ts_query
    -- Apply same optional filters here
    LIMIT 20
)
SELECT e.id, e.uuid, e.created_at, e.city, e.starred,
       LEFT(e.text, 300) AS preview,
       COALESCE(1.0 / (60 + s.rank_s), 0) + COALESCE(1.0 / (60 + f.rank_f), 0) AS rrf_score
FROM entries e
LEFT JOIN semantic s ON e.id = s.id
LEFT JOIN fulltext f ON e.id = f.id
WHERE s.id IS NOT NULL OR f.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT $3;
```

The constant `60` in the RRF formula is standard (k=60). It smooths ranking differences between the two retrieval systems.

The search tool must embed the query string at runtime using the same OpenAI model used for indexing.

### get_entry

```typescript
{
  name: 'get_entry',
  description: 'Get a single journal entry by its UUID with full text, metadata, tags, and media info.',
  params: {
    uuid: { type: 'string', required: true },
  },
}
```

### get_entries_by_date

```typescript
{
  name: 'get_entries_by_date',
  description: 'Get all entries within a date range, ordered chronologically.',
  params: {
    date_from: { type: 'string', format: 'YYYY-MM-DD', required: true },
    date_to: { type: 'string', format: 'YYYY-MM-DD', required: true },
    limit: { type: 'number', default: 20, max: 50 },
  },
}
```

### on_this_day

```typescript
{
  name: 'on_this_day',
  description: 'Find entries written on this calendar day (MM-DD) across all years. Great for reflection and year-over-year comparison.',
  params: {
    month_day: { type: 'string', format: 'MM-DD', required: true },
  },
}
```

SQL: `WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(DAY FROM created_at) = $2`

### find_similar

```typescript
{
  name: 'find_similar',
  description: 'Find entries semantically similar to a given entry. Uses cosine similarity on embeddings.',
  params: {
    uuid: { type: 'string', required: true, description: 'UUID of the source entry' },
    limit: { type: 'number', default: 5, max: 20 },
  },
}
```

SQL: Get the source entry's embedding, then `ORDER BY embedding <=> source_embedding LIMIT N` excluding the source itself.

### list_tags

```typescript
{
  name: 'list_tags',
  description: 'List all unique tags with their usage counts, ordered by frequency.',
  params: {},
}
```

### entry_stats

```typescript
{
  name: 'entry_stats',
  description: 'Get writing statistics: entry count, word count trends, writing frequency by day of week and month, average entry length over time.',
  params: {
    date_from: { type: 'string', format: 'YYYY-MM-DD', required: false },
    date_to: { type: 'string', format: 'YYYY-MM-DD', required: false },
  },
}
```

---

## Environment Configuration

### `.env.example`

```bash
# Database
DATABASE_URL=postgresql://dev:dev@localhost:5432/journal_dev

# OpenAI (for embedding generation)
OPENAI_API_KEY=sk-...

# Server
NODE_ENV=development
PORT=3000
```

### `.env.development`

```bash
DATABASE_URL=postgresql://dev:dev@localhost:5432/journal_dev
NODE_ENV=development
```

### `.env.test`

```bash
DATABASE_URL=postgresql://test:test@localhost:5433/journal_test
NODE_ENV=test
```

### `src/config.ts`

```typescript
import 'dotenv/config';

const env = process.env.NODE_ENV || 'development';

export const config = {
  env,
  database: {
    url: process.env.DATABASE_URL || {
      development: 'postgresql://dev:dev@localhost:5432/journal_dev',
      test: 'postgresql://test:test@localhost:5433/journal_test',
      production: '',
    }[env] || '',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: 'text-embedding-3-small' as const,
    embeddingDimensions: 1536,
  },
  embedding: {
    batchSize: 100,
  },
} as const;
```

---

## Docker Compose Files

### `docker-compose.yml` (Development)

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: journal_dev
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./specs/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dev -d journal_dev"]
      interval: 2s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
```

### `docker-compose.test.yml` (Testing — different port!)

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: journal_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    volumes:
      - ./specs/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test -d journal_test"]
      interval: 2s
      timeout: 5s
      retries: 10
    tmpfs:
      - /var/lib/postgresql/data  # RAM-backed for speed, no persistence needed
```

Note: Test DB uses `tmpfs` for speed — no persistence needed. Port 5433 avoids collision with dev DB.

---

## Agent Development Harness

This is critical. The coding agent must have a closed loop for evaluating its work.

### `package.json` scripts

```json
{
  "scripts": {
    "check": "pnpm typecheck && pnpm lint && pnpm test",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ tests/ scripts/ --max-warnings 0",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:watch": "vitest",
    "build": "tsc",
    "start": "node dist/index.js",
    "start:http": "node dist/index.js --http",
    "dev": "tsx src/index.ts",
    "dev:db": "docker compose up -d",
    "dev:db:reset": "docker compose down -v && docker compose up -d",
    "dev:db:logs": "docker compose logs -f db",
    "migrate": "tsx scripts/migrate.ts",
    "import": "tsx scripts/import-journal.ts",
    "embed": "tsx scripts/embed-entries.ts"
  }
}
```

### `CLAUDE.md`

This file tells any coding agent how to work on this project. Write it with these sections:

```markdown
# journal-mcp

MCP server for semantic journal search over Day One exports in PostgreSQL + pgvector.

## Development Loop

After EVERY code change, run:

    pnpm check

This runs in order (short-circuits on first failure):
1. `tsc --noEmit` — Type errors mean your interfaces don't match the spec
2. `eslint` — Style violations, unused imports
3. `vitest run` — Unit + integration tests

**Do not move on until `pnpm check` passes.**

## Quick Start

    pnpm install
    docker compose up -d          # Start dev PG
    pnpm migrate                  # Apply schema
    pnpm import -- path/to/Journal.json  # Import Day One export
    pnpm embed                    # Generate embeddings

## Architecture

- `specs/tools.spec.ts` is the source of truth for all tool definitions
- Tool registration in `src/server.ts` reads from the spec
- Tests validate against the spec
- Database schema lives in `specs/schema.sql`

## Test Strategy

- **Unit tests** (`tests/tools/`, `tests/formatters/`): No DB needed. Test param validation, formatting, spec conformance.
- **Integration tests** (`tests/integration/`): Require PG. Auto-started via docker compose in vitest globalSetup. Test actual SQL queries, RRF ranking, embedding search.

Tests use pre-computed embeddings in fixtures for determinism — no OpenAI calls during tests.

## Key Patterns

- All SQL is in `src/db/queries.ts` as parameterized queries (never string interpolation)
- Config is env-aware: reads NODE_ENV to pick database URL
- Formatters convert raw DB rows to human-readable MCP tool output
- The RRF search combines BM25 (tsvector) + vector cosine similarity with k=60

## Adding a New Tool

1. Add spec to `specs/tools.spec.ts`
2. Write test in `tests/tools/`
3. Add query to `src/db/queries.ts`
4. Implement tool in `src/tools/`
5. Add formatter in `src/formatters/`
6. Register in `src/server.ts`
7. Run `pnpm check`
```

---

## Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/tools/**/*.test.ts', 'tests/formatters/**/*.test.ts'],
          exclude: ['tests/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/setup/global-setup.ts'],
          setupFiles: ['tests/setup/per-test-setup.ts'],
        },
      },
    ],
  },
});
```

### `tests/setup/global-setup.ts`

Handles Docker lifecycle for integration tests:

```typescript
import { execSync } from 'child_process';

export async function setup() {
  console.log('🐳 Starting test database...');
  execSync('docker compose -f docker-compose.test.yml up -d --wait', {
    stdio: 'inherit',
  });

  // Run migrations against test DB
  execSync('pnpm migrate', {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://test:test@localhost:5433/journal_test',
      NODE_ENV: 'test',
    },
  });
}

export async function teardown() {
  console.log('🐳 Stopping test database...');
  execSync('docker compose -f docker-compose.test.yml down -v', {
    stdio: 'inherit',
  });
}
```

### `tests/setup/per-test-setup.ts`

Clean state between tests:

```typescript
import { pool } from '../../src/db/client.js';
import { seedFixtures } from '../../specs/fixtures/seed.js';
import { beforeEach, afterAll } from 'vitest';

beforeEach(async () => {
  // Truncate in dependency order
  await pool.query('TRUNCATE entry_tags, media, tags, entries RESTART IDENTITY CASCADE');
  await seedFixtures(pool);
});

afterAll(async () => {
  await pool.end();
});
```

### `tests/helpers/assertions.ts`

Custom assertions with actionable hints so the agent knows what to fix:

```typescript
export function expectSearchResults(
  results: any[],
  context: { query: string; minCount?: number }
) {
  const min = context.minCount ?? 1;
  if (results.length < min) {
    throw new Error(
      `Expected at least ${min} results for query "${context.query}" but got ${results.length}.\n` +
        `Hint: Check that embeddings exist in test fixtures (specs/fixtures/seed.ts).\n` +
        `Hint: Verify the RRF query in src/db/queries.ts handles NULL embeddings.\n` +
        `Run \`pnpm test:integration -- --reporter=verbose\` for full trace.`
    );
  }
}

export function expectEntryShape(entry: any) {
  const required = ['uuid', 'created_at', 'preview'];
  const missing = required.filter((k) => !(k in entry));
  if (missing.length > 0) {
    throw new Error(
      `Entry missing required fields: ${missing.join(', ')}.\n` +
        `Hint: Check the formatter in src/formatters/entry.ts.`
    );
  }
}
```

---

## Fixtures

### `specs/fixtures/sample-export.json`

Create a realistic but small Day One export with ~10 entries. Include variety:
- Entries with and without location, weather, tags, photos
- Different cities, timezones, devices
- Different lengths (short 200-token entry, medium ~1K, one longer ~2K)
- Date spread across multiple years and months
- Some entries with the same MM-DD for testing `on_this_day`

### `specs/fixtures/seed.ts`

Test seed data with **pre-computed embedding vectors** so tests are deterministic (no OpenAI calls). For the embedding vectors, generate realistic-looking random 1536-dim float arrays — the exact values don't matter for unit tests, but for integration tests testing cosine similarity, make entries about similar topics have similar vectors (e.g., copy a vector and add small noise for "similar" entries).

```typescript
export interface FixtureEntry {
  uuid: string;
  text: string;
  created_at: string;
  city?: string;
  country?: string;
  tags?: string[];
  starred?: boolean;
  template_name?: string;
  embedding: number[]; // 1536-dim pre-computed
}

export const fixtureEntries: FixtureEntry[] = [
  // Include ~8-10 entries with diverse themes
];

export async function seedFixtures(pool: Pool) {
  // Insert entries, tags, entry_tags from fixtureEntries
}
```

---

## Implementation Order

Build in this order. After each step, run `pnpm check` and ensure it passes before moving on.

### Phase 1: Skeleton
1. Initialize repo: `pnpm init`, install deps, set up tsconfig, eslint, vitest config
2. Create all directories and placeholder files
3. Write `specs/schema.sql`, `docker-compose.yml`, `docker-compose.test.yml`
4. Write `src/config.ts`
5. Write `src/db/client.ts`
6. Verify: `pnpm typecheck` passes

### Phase 2: Spec + Fixtures
1. Write `specs/tools.spec.ts` with all tool definitions
2. Write `specs/fixtures/seed.ts` with test data
3. Write `specs/fixtures/sample-export.json`
4. Write test setup files (`global-setup.ts`, `per-test-setup.ts`)
5. Write test helpers (`assertions.ts`)

### Phase 3: Database Layer
1. Write `scripts/migrate.ts`
2. Write `src/db/queries.ts` — all SQL queries as parameterized functions
3. Write `src/db/embeddings.ts` — OpenAI embedding helper
4. Write integration tests for queries
5. Verify: `pnpm test:integration` passes

### Phase 4: Tools + Formatters
1. Write formatters first (`src/formatters/`)
2. Write each tool (`src/tools/`) — implement against spec
3. Write unit tests per tool
4. Verify: `pnpm test:unit` passes

### Phase 5: MCP Server
1. Write `src/server.ts` — tool registration reading from spec
2. Write `src/index.ts` — stdio + HTTP transport
3. Verify: `pnpm check` fully passes

### Phase 6: Scripts
1. Write `scripts/import-journal.ts`
2. Write `scripts/embed-entries.ts`
3. Test import with `specs/fixtures/sample-export.json`

### Phase 7: Deployment
1. Write `Dockerfile` (multi-stage: build → runtime)
2. Write `railway.json`
3. Write `README.md`
4. Write `CLAUDE.md` (the agent instructions document)

---

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "pg": "^8",
    "pgvector": "^0.2",
    "dotenv": "^16",
    "openai": "^4",
    "zod": "^3"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/pg": "^8",
    "typescript": "^5",
    "vitest": "^2",
    "tsx": "^4",
    "eslint": "^9",
    "@eslint/js": "^9",
    "typescript-eslint": "^8",
    "prettier": "^3"
  }
}
```

Use `zod` for runtime param validation on tool inputs (same pattern as oura-ring-mcp).

---

## Key Implementation Details

### The RRF Search Must Embed Queries at Runtime

`search_entries` needs to call OpenAI to embed the query string, then use that vector in the SQL. Cache nothing — queries are fast enough.

### Tags Are Normalized

The `tags` table is separate. When importing, upsert tags and create junction records. When filtering by tag, JOIN through `entry_tags`.

### The Import Script Should Be Idempotent

Use `ON CONFLICT (uuid) DO UPDATE` so re-running the import updates existing entries rather than failing on duplicates.

### Formatters Produce Human-Readable Strings

MCP tools return strings (or structured content). Formatters should produce something like:

```
📅 November 15, 2025 — Barcelona, Spain
🏷️ morning-review, nicotine
⭐ Starred

Woke up feeling depleted. The nicotine yesterday definitely crashed
my dopamine baseline. Readiness score was 34...

---
☁️ Partly Cloudy, 18°C | 📍 Eixample
```

### Config Must Fail Fast in Production

If `DATABASE_URL` is empty in production, throw immediately on startup — don't wait for the first query to fail.

---

## What NOT to Build Yet

- Clustering analysis (HDBSCAN over embeddings) — Phase 3 future work
- Oura data correlation — future tool, needs cross-DB queries
- Write/update tools — this is read-only for now
- Authentication beyond what MCP SDK provides
- Web UI or dashboard
