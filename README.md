# journal-mcp

An MCP server for semantic search over personal journal data, built to replace Day One's native MCP with something dramatically more capable.

## Why This Exists

Day One has an MCP integration that lets LLMs read and write journal entries. In practice, it's limited:

- **Multi-term search is broken** — querying for more than one term frequently returns zero results
- **No semantic search** — you can ask "what did I write on December 5th" but not "entries where I was processing difficult emotions about work"
- **No fuzzy matching** — typos or paraphrased concepts return nothing
- **Limited pagination** — `query` mode ignores the `offset` parameter, so you're capped at whatever `limit` you set (max 50)
- **No cross-entry analysis** — no way to find similar entries, discover recurring themes, or correlate patterns over time

This project exports the full Day One journal into PostgreSQL with pgvector, then puts an MCP server in front of it that supports hybrid semantic + keyword search, entry similarity, and structured queries that actually work.

## The Search Problem

The core question was: **how do you search 5.8 million tokens of personal journal data?**

### Options Considered

**1. Load everything into context**
Not viable. At 5.8M tokens, this exceeds even Gemini's 2M context window, and even if it fit, the cost per query would be prohibitive. Also not great for precision — LLMs get worse at retrieval as context grows.

**2. Agent-based grep / iterative search**
An LLM agent that runs `grep` or SQL queries iteratively. This works for exact matches but fails for the fuzzy/semantic use case ("entries about feeling stuck"). Also slow — multiple round trips per query.

**3. Full-text search only (BM25 / tsvector)**
PostgreSQL's built-in `tsvector` + `tsquery` with `ts_rank`. Surprisingly good for keyword search and handles multi-term queries natively (solving Day One's main bug). But purely lexical — "nervous system dysregulation" won't match an entry that says "my body felt wired and I couldn't calm down."

**4. Vector embeddings only**
Embed every entry, search by cosine similarity. Great for semantic matching but terrible for exact keyword lookups. Searching for "Barcelona" might return entries about Spain that don't mention Barcelona specifically.

**5. Hybrid: BM25 + Vector with Reciprocal Rank Fusion (RRF)**
Combine both approaches. Run a keyword search AND a semantic search, then merge the ranked results using RRF. This is the current state of the art for retrieval quality and what we went with.

### Why Vector Embeddings Still Make Sense Here

There's a narrative that embeddings have "fallen out of favor" due to larger context windows. That's partially true for RAG over documents where you just need to find the right chunk and stuff it into context. But for this use case, embeddings are still the right tool:

- **5.8M tokens can't fit in context** — retrieval is mandatory, not optional
- **The goal is discovery, not just retrieval** — "what themes recur in my writing?" is a clustering question that embeddings answer naturally
- **Journal entries are naturally chunked** — each entry is a semantic unit with clear boundaries, so the chunking problem that plagues RAG pipelines doesn't apply here

### Reciprocal Rank Fusion

RRF merges ranked lists from different retrieval systems without needing to normalize scores across them. The formula:

```
RRF_score(d) = Σ 1 / (k + rank_i(d))
```

Where `k` is a constant (we use 60, the standard value) and `rank_i(d)` is document `d`'s rank in retrieval system `i`. A document ranked #1 in both systems gets `1/61 + 1/61 = 0.0328`. A document ranked #1 in one and #10 in the other gets `1/61 + 1/70 = 0.0307`. The constant `k` prevents any single high rank from dominating.

In practice, this means:
- A query like "Barcelona" returns entries mentioning Barcelona (BM25 finds them) even if the semantic meaning is unrelated
- A query like "feeling overwhelmed by project management" returns entries about work stress even if those exact words aren't used (vector search finds them)
- An entry that's relevant both semantically AND contains the keywords ranks highest

## Dataset

The journal data comes from a Day One JSON export:

| Metric | Value |
|--------|-------|
| Total entries | 2,836 |
| Min tokens | 200 |
| Max tokens | 7,778 |
| Mean tokens | 1,949 |
| Median tokens | 1,963 |
| Total tokens | ~5.8M |

Since the median entry is ~2K tokens and the max is ~8K, every entry fits comfortably in a single embedding (OpenAI's `text-embedding-3-small` handles up to 8,191 tokens). No chunking strategy needed — one embedding per entry.

### Metadata Available

Every entry has timestamps, device info, and UUIDs. Most entries include:

- **Location** (2,625/2,836) — lat/lng, city, place name, country, admin area
- **Weather** (2,521/2,836) — temperature, conditions, humidity, wind, moon phase, sunrise/sunset
- **User activity** (2,241/2,836) — activity type and step count
- **Tags** (1,510/2,836) — user-created labels
- **Templates** (1,448/2,836) — template name (e.g., "5 Minute AM")
- **Photos** (832 entries, 1,354 photos) — with full EXIF data
- **Videos** (75 entries), **Audio** (9 entries)

This metadata enables structured filtering (entries in Barcelona, entries tagged "morning-review", entries on workout days) combined with semantic search.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Claude / LLM  │────▶│  journal-mcp     │────▶│  PostgreSQL 16      │
│   (MCP Client)  │◀────│  (MCP Server)    │◀────│  + pgvector         │
└─────────────────┘     └──────────────────┘     │  + pg_trgm          │
                               │                  │  + tsvector         │
                               ▼                  └─────────────────────┘
                        ┌──────────────┐
                        │  OpenAI API  │
                        │  (embedding  │
                        │   queries)   │
                        └──────────────┘
```

### Data Flow

1. **One-time import**: Day One JSON export → parse → insert into PostgreSQL with structured columns for location, weather, tags, etc.
2. **One-time embedding**: Batch-embed all entries via OpenAI `text-embedding-3-small` (~$0.12 for the full corpus) and store vectors in pgvector
3. **At query time**: User query → embed query string → run RRF (BM25 + cosine similarity) → format results → return via MCP

### Why PostgreSQL

Everything in one database:
- **pgvector** for cosine similarity search over embeddings
- **tsvector** for BM25-style full-text search with ranking
- **pg_trgm** for trigram-based fuzzy string matching (typo tolerance)
- Standard SQL for structured queries (date ranges, tag filtering, aggregations)
- No need for a separate vector store (Pinecone, Weaviate, etc.) or search engine (Elasticsearch)

For ~3K entries, PostgreSQL handles everything with ivfflat indexing. If the dataset grows significantly, HNSW indexing is available as a drop-in replacement.

## Tools

### Data Retrieval

| Tool | Description |
|------|-------------|
| `search_entries` | Hybrid RRF search (semantic + BM25) with optional date, tag, city, and starred filters |
| `get_entry` | Full entry by UUID with all metadata, tags, and media info |
| `get_entries_by_date` | All entries in a date range, chronologically ordered |
| `on_this_day` | Entries from a specific MM-DD across all years — for year-over-year reflection |
| `find_similar` | Entries semantically similar to a given entry (cosine similarity) |
| `list_tags` | All unique tags with usage counts |
| `entry_stats` | Writing frequency, word count trends, patterns by day of week |

### Example Queries

**Semantic search** — finds entries by meaning, not just keywords:
- "entries about struggling with work boundaries"
- "times I wrote about feeling grounded and present"
- "processing difficult conversations"

**Hybrid search** — combines semantic understanding with keyword precision:
- "Barcelona morning routine" — finds entries in Barcelona about mornings
- "nicotine dopamine" — exact terms + semantically related entries about stimulant effects

**Structured queries** — metadata-driven:
- All entries tagged "evening-review" from January 2026
- Starred entries written in San Diego
- What did I write on this day across all years?

**Discovery** — finding patterns you didn't know existed:
- "Find entries similar to [this one about a breakthrough moment]"
- Writing frequency trends over the past year
- Tags I use most and least

## Web App — Reflective Journal Engine

The MCP server is the brain, but it needs a body. The next phase is a web-based journal frontend that replaces Day One entirely — a PWA that works on desktop and mobile, backed by the same PostgreSQL database, with the MCP server powering a reflective AI layer on top.

### Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | **SvelteKit** | Smaller bundles for PWA, simpler reactivity model for managing editor state and autosave, less boilerplate than React for a solo project |
| Editor | **Tiptap** (ProseMirror) | Rich-text WYSIWYG with markdown shortcuts, clean extension system, first-class Svelte support. Minimal toolbar — this is a journal, not Google Docs |
| Styling | **Tailwind CSS** | Utility-first, fast iteration, easy dark mode |
| Database | **PostgreSQL 16** | Shared with the MCP server — pgvector, tsvector, pg_trgm already in place |
| Auth | **TBD** | Single-user to start (token-based), expand later if needed |
| Hosting | **Railway** | Already deployed here for the MCP server, keeps everything colocated |

### Core Features

**Writing experience** — the part that has to feel good or nothing else matters:
- Tiptap editor with markdown shortcuts (headings, bold, lists, code blocks)
- Autosave on pause (debounced writes, no save button)
- Tagging, starring, location/weather metadata (auto-populated where possible)
- Photo/media attachments
- Mobile-responsive — full PWA with offline draft support

**Reflective engine** — what makes this more than a text box:
- **On-write reflection**: After saving, an async pipeline generates the embedding, extracts themes/mood, and optionally surfaces a prompt like "you wrote something similar 3 weeks ago — here's how your perspective has shifted"
- **Semantic search**: The same hybrid RRF search from the MCP server, exposed in the UI as a search bar that understands meaning, not just keywords
- **Memory explorer**: Browse entries by semantic clusters, recurring themes, or timeline. "Show me everything I've written about work boundaries" as a first-class UI interaction
- **On This Day**: Year-over-year reflection view, already supported by the `on_this_day` MCP tool

**Scheduled digests** — automating the evening review:
- Weekly/monthly pattern analysis generated from embeddings and metadata
- Mood trajectory visualization over time
- Surfaced connections between entries the writer wouldn't notice manually

### Architecture with Web App

```
┌──────────────────────────────────────────────────────────────┐
│                        Web App (SvelteKit PWA)               │
│  ┌─────────────┐  ┌───────────────┐  ┌────────────────────┐ │
│  │ Tiptap       │  │ Semantic      │  │ Memory Explorer /  │ │
│  │ Editor       │  │ Search Bar    │  │ On This Day        │ │
│  └──────┬──────┘  └──────┬────────┘  └────────┬───────────┘ │
│         │                │                     │             │
│         ▼                ▼                     ▼             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              SvelteKit API Routes                     │   │
│  │   /api/entries  /api/search  /api/similar  /api/stats │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              │
                              ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Claude / LLM  │────▶│  journal-mcp     │────▶│  PostgreSQL 16      │
│   (MCP Client)  │◀────│  (MCP Server)    │◀────│  + pgvector         │
└─────────────────┘     └──────────────────┘     │  + pg_trgm          │
                               │                  │  + tsvector         │
                               ▼                  └─────────────────────┘
                        ┌──────────────┐
                        │  OpenAI API  │
                        │  (embedding  │
                        │   queries)   │
                        └──────────────┘
```

The web app and MCP server share the same PostgreSQL database. The SvelteKit API routes handle CRUD and search directly, while the MCP server continues to serve Claude and other LLM clients. Entries created in the web app are immediately available via MCP, and vice versa — a single source of truth.

### Development Phases

**Phase 1 — Write & Read**: SvelteKit scaffold, Tiptap editor, entry CRUD, autosave, basic entry list/timeline view. No AI features yet — just a functional journal that replaces Day One for daily use.

**Phase 2 — Search & Browse**: Wire up the existing hybrid RRF search to a search bar in the UI. Add tag browsing, date filtering, On This Day view. Entry detail view with full metadata.

**Phase 3 — Reflect**: On-write embedding pipeline (async, non-blocking). Similarity suggestions ("entries like this one"). Memory explorer with semantic clusters. Weekly digest generation.

**Phase 4 — PWA & Polish**: Service worker for offline draft support, install prompt, responsive mobile layout, dark mode, keyboard shortcuts, export functionality.

## Future Work

### Intelligence Layer

- **Coaching sessions** — an embedded chat interface within the journal app that talks to Claude via the MCP server. Write an entry, then have a reflective back-and-forth about it with full context of your journal history. The LLM becomes a thought partner that actually knows what you've been working through.

- **Prompted writing challenges** — the system notices gaps and nudges toward deeper reflection. "You haven't written about X in 3 weeks." "You've described this problem 5 times but never explored potential solutions." "Your entries about work have shifted tone this month — want to explore why?" Pattern-aware prompts rather than generic journaling questions.

- **Auto-generated reviews** — one-click monthly/quarterly reflection documents. The system uses embeddings and metadata to draft a structured review: dominant themes, how they compare to the previous period, entries that represent turning points, and open threads worth revisiting. Designed to automate the monthly review process with data-backed insights.

- **Contextual prompts** — time-of-day and day-of-week aware suggestions surfaced when you open the app. "It's Monday morning — last Monday you were processing the boundary conversation with your manager" or "You tend to write about creative projects on weekends but haven't in two weeks." Uses temporal metadata patterns rather than live location (since journaling happens at the same place most days).

### Visualization & Discovery

- **Temporal drift visualization** — 2D projections (UMAP/t-SNE) of journal entries over time, color-coded by month, mood, or tag. Watch clusters form, tighten, and dissolve as your thinking about a topic evolves. Zoom into a cluster to see which entries live there. This is the kind of self-knowledge that's impossible to get from reading entries sequentially.

- **Multi-modal timeline** — entries, photos, Oura biometrics (HRV, readiness, sleep), and potentially Spotify listening history on a single unified timeline. "What was I listening to, how was my HRV, and what did I write on the day I decided to move to Barcelona?" A complete view of a moment from every available data source.

- **Ritual detection** — the system identifies behavioral patterns you might not be conscious of. "You journal about gratitude every Sunday morning." "Your longest entries happen after days with 8K+ steps." "You haven't used the evening-review tag in 10 days." Surfaces the rituals you've built without realizing it — and the ones that have quietly dropped off.

- **Clustering analysis** — HDBSCAN or k-means over embeddings to discover recurring themes automatically, with temporal analysis showing how themes shift over months.

### Entry Types & Capture

- **Dream journaling mode** — a stripped-down entry type optimized for the half-awake window. Large text, minimal UI, voice-first input via Whisper transcription. Entries auto-tagged as dreams with their own search namespace. Over time, semantic search across dreams specifically becomes powerful — "recurring themes in my dreams over the past 6 months."

- **Voice-to-journal** — a record button that captures audio, transcribes via Whisper, and saves as an entry. The transcription becomes the searchable text, gets embedded like everything else, and the original audio is stored for playback. For when you need to process something verbally.

- **Mood as metadata** — lightweight per-entry mood tags (emoji or single word) rather than a single daily score. Since mood changes throughout the day, attaching it to individual entries gives meaningful granularity. Combined with LLM-inferred sentiment from entry text as a secondary signal, this becomes a queryable dimension for correlation with biometrics, location, time of day, and tags.

### Data Integration

- **Oura Ring correlation** — cross-reference journal themes with biometric data (HRV, readiness, sleep quality) from the [oura-ring-mcp](https://github.com/mitchhankins01/oura-ring-mcp) dataset. "How do I write on days when my readiness is below 50?" or "Do entries about feeling grounded correlate with higher HRV?"

- **Temporal embeddings** — track how writing about a topic evolves over time by comparing embedding drift. Measure how your relationship to a concept (work, home, identity) changes month over month.

- **Write-back tools** — create/update entries from the MCP server (currently read-only).

## Development

### Prerequisites

- Node.js (see `.nvmrc`)
- pnpm
- Docker (for PostgreSQL + pgvector)

### Setup

```bash
pnpm install
docker compose up -d              # Start dev PostgreSQL
pnpm migrate                      # Apply schema
pnpm import -- path/to/Journal.json  # Import Day One export
pnpm embed                        # Generate embeddings (~$0.12)
```

### Development Loop

```bash
pnpm check    # typecheck → lint → test (the only command you need)
```

This runs TypeScript type checking, ESLint, and vitest in order, short-circuiting on first failure. Integration tests automatically start/stop a test PostgreSQL container via Docker Compose on port 5433 (isolated from the dev DB on 5432).

### Environment Separation

| Environment | Database | Port | Purpose |
|-------------|----------|------|---------|
| Development | `journal_dev` | 5432 | Local iteration, schema experiments |
| Test | `journal_test` | 5433 | Automated tests, tmpfs-backed for speed |
| Production | Railway PG | — | Live MCP server |

### Spec-Driven Development

The project follows spec-driven development:

1. `specs/tools.spec.ts` defines every tool's interface (params, types, descriptions, examples)
2. Tool registration reads from the spec
3. Tests validate against the spec
4. Adding a new tool starts with updating the spec, not writing implementation

Test fixtures include pre-computed embedding vectors for determinism — no OpenAI API calls during tests.

## Deployment

Deployed to Railway with the same patterns as [oura-ring-mcp](https://github.com/mitchhankins01/oura-ring-mcp):

```bash
# Railway needs:
# - PostgreSQL addon with pgvector (or Neon/Supabase)
# - DATABASE_URL (auto-set by Railway PG addon)
# - OPENAI_API_KEY (for query-time embedding)
```

Supports both stdio transport (for Claude Desktop) and HTTP/SSE transport (for remote/Railway deployment).

### Optional Telegram Bot

The project includes an optional Telegram chatbot (single-user scoped by chat ID).

Required env vars when enabling Telegram:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_ID`
- `OPENAI_API_KEY` (embeddings + Whisper + voice reply TTS)

Provider configuration:

- `TELEGRAM_LLM_PROVIDER=anthropic|openai`
- `ANTHROPIC_API_KEY` required when provider is `anthropic`

Voice reply controls:

- `TELEGRAM_VOICE_REPLY_MODE=off|adaptive|always`
- `TELEGRAM_VOICE_REPLY_EVERY` (adaptive cadence for text-origin chats)
- `TELEGRAM_VOICE_REPLY_MIN_CHARS` / `TELEGRAM_VOICE_REPLY_MAX_CHARS`
- `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE`

## License

MIT
