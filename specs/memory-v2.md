# Memory v2 — Memory Architecture & Shared Personality

## Status: Implemented

## What

Redesign of the memory layer and shared personality system. Decouples memory creation from Telegram compaction, simplifies pattern kinds from 9 → 3, adds MCP tools for interface-agnostic memory access, and makes soul state global.

Subsumes `specs/chat-archive.md` — the `save_chat` tool replaces the standalone chat archive concept.

## Audit Findings

Production audit (March 2026) of 90 patterns from a 2-week Telegram burst revealed:

- **Event bloat**: 43% of patterns are granular events, many duplicated 3-4x (0.82 dedup threshold too conservative)
- **Stale facts**: 5 contradictory weight entries, temporal facts stored as durable ("hasn't replied to email as of Feb 22")
- **Miscategorized kinds**: Travel plans as "behavior", career moves as "goal" — LLM can't reliably distinguish 9 kinds
- **Low retrieval quality**: Avg 1.5 patterns returned per query, avg top score 0.52 (barely above threshold)
- **Interface blindness**: Primary interface (Claude Desktop via MCP) produces zero patterns — extraction only happens during Telegram compaction
- **Compaction conflation**: Memory creation is a side effect of context window management — quality suffers because extraction is batch garbage collection, not intentional memory

## Core Architectural Change

**Decouple memory creation from context management.**

| Concern | Before (v1) | After (v2) |
|---------|-------------|------------|
| Memory creation | Side effect of compaction | Intentional via `remember` / `save_chat` tools |
| Compaction | Extracts patterns + trims context | Pure context trimming (summarize + discard) |
| Write interface | Telegram only | Any interface (MCP tools) |
| Pattern kinds | 9 (frequently miscategorized) | 3: identity, preference, goal |
| Events | Stored as patterns (redundant) | Journal entries are the event store |
| Soul state | Per-chat, Telegram only | Global singleton, any interface |

## Pattern Kinds

### 3 kinds (down from 9)

| Kind | What it captures | Half-life | Floor | Examples |
|------|-----------------|-----------|-------|----------|
| identity | Durable biographical facts about the user or their world | 3650 days | 0.85 | "Lives in Barcelona", "Jesse's birthday is March 15", "Allergic to penicillin" |
| preference | Values, beliefs, habits, recurring choices | 180 days | 0.40 | "Prefers working from cafes", "Uses 'crash cómodo' framework for recovery days" |
| goal | Active intentions with directionality | 90 days | 0.30 | "Reach B2 Spanish by June", "Reply to therapist's email" |

**No event kind.** Journal entries are the event store — already searchable and embedded. Forward-looking events ("surgery on April 10") are stored as `identity` with temporal metadata:

```json
{ "temporal": { "date": "2026-04-10", "relevance": "upcoming" } }
```

### Kind migration

| Old (v1) | New (v2) | Rationale |
|----------|----------|-----------|
| fact | identity | Renamed for clarity |
| event | _(dropped)_ | Journal entries are the event store |
| belief, preference, behavior | preference | All "what user values/does/thinks" |
| emotion, temporal, causal | _(absorbed)_ | → preference (recurring) or identity (durable) |
| goal | goal | Unchanged |

## MCP Tools

### `remember` — Store a single pattern

```
Params:
  content: string       — The pattern to remember
  kind: identity | preference | goal
  confidence?: number   — 0.0-1.0, default 0.8
  evidence?: string     — Why this is being stored
  entry_uuids?: string[] — Link to journal entries
  temporal?: { date?: string, relevance?: "upcoming" | "ongoing" }
```

- Runs dedup pipeline: hash check → embed → ANN similarity check (0.80 threshold) → insert or reinforce
- Sets `source_type = 'mcp_explicit'`
- Fast — no LLM call needed
- Available to both MCP clients and Telegram agent's tool list
- Telegram agent calls this mid-conversation when it hears something worth storing

### `save_chat` — Batch extract patterns from a conversation

```
Params:
  messages: string      — Conversation transcript
  context?: string      — Topic hint for better extraction
```

- Reuses extraction prompt (refactored from compaction) with quality gates:
  - Only 3 kinds (identity, preference, goal)
  - Negative examples: no biometric dumps, hypotheticals, assistant suggestions
  - Post-extraction validation: content 10-200 chars, evidence required, confidence ≥ 0.4, implicit signal ≥ 0.6
  - Max 5 patterns per extraction
- Returns: summary of patterns found, stored, reinforced, skipped
- Sets `source_type = 'mcp_chat_archive'`
- This is how Claude Desktop conversations feed the memory system

### `recall` — Search memory

```
Params:
  query: string         — Search query
  kinds?: string[]      — Filter by kind
  limit?: number        — Default 10, max 20
```

- Calls `searchPatterns()` with typed-decay scoring
- Returns formatted list with kind, confidence, times_seen, last_seen

### `reflect` — Memory maintenance

```
Params:
  action: "consolidate" | "review_stale" | "stats"
  kind?: string         — Filter to specific kind
```

- `consolidate`: Find clusters of similar active patterns (cosine > 0.78), reinforce keeper patterns, add aliases/relations, and supersede overlaps
- `review_stale`: Return patterns not seen in 90+ days
- `stats`: Pattern counts by kind/status, avg confidence, total active

## Compaction Changes

### Before (v1)
1. Size/time trigger → take oldest half of messages
2. LLM extracts patterns from those messages
3. Mark messages as compacted
4. Run pulse check

### After (v2)
1. Size trigger only (12k token threshold — context window management)
2. Generate brief summary of compacted messages (conversational continuity)
3. Store summary (so bot doesn't lose thread)
4. Mark messages as compacted
5. No pattern extraction during compaction

### Telegram agent as active memory participant

Instead of batch-extracting during compaction, the agent uses `remember` as a tool during conversation:

- `remember` added to agent's available tools
- System prompt guidance: "When the user shares biographical facts, preferences, goals, or important future dates, call `remember` to store them. Store important information as you hear it."
- Agent decides in real-time what's worth storing, with full conversational context

## Retrieval Improvements

### Lower thresholds

| Param | v1 | v2 |
|-------|-----|-----|
| `RETRIEVAL_BASE_MIN_SIMILARITY` | 0.45 | 0.35 |
| `RETRIEVAL_SHORT_QUERY_MIN_SIMILARITY` | 0.52 | 0.42 |
| `RETRIEVAL_SCORE_FLOOR_DEFAULT` | 0.35 | 0.20 |
| `RETRIEVAL_SCORE_FLOOR_SHORT_QUERY` | 0.50 | 0.35 |

Fewer, higher-quality patterns make lower thresholds safer.

### Hybrid retrieval

The `patterns` table uses a hybrid path: semantic retrieval + text retrieval merged with RRF (k=60), mirroring how `search_entries` works:

```typescript
const [semantic, textual] = await Promise.all([
  semanticSearchPatterns(pool, queryEmbedding, 15, minSimilarity),
  textSearchPatterns(pool, queryText, 10),
]);
return rrfMerge(semantic, textual, 60);
```

## Shared Soul State

### Global singleton table

```sql
CREATE TABLE IF NOT EXISTS soul_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    identity_summary TEXT NOT NULL,
    relational_commitments TEXT[] NOT NULL DEFAULT '{}',
    tone_signature TEXT[] NOT NULL DEFAULT '{}',
    growth_notes TEXT[] NOT NULL DEFAULT '{}',
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by TEXT NOT NULL DEFAULT 'system'
);
```

- Migrated from per-chat `chat_soul_state` → global `soul_state`
- Optimistic locking via `version` column (same pattern as artifacts)
- `buildSoulPromptSection()` already a pure function — reuse for MCP context injection
- Soul evolution moves from compaction trigger to periodic (every N messages or timer)

## Automated Consolidation

### Periodic background work
- Wired into hourly Oura sync timer
- Find clusters of similar active patterns (cosine > 0.78 within same kind), reinforce + alias + supersede
- Active pattern cap: 40 max, deprecate lowest-scored excess
- Prune expired patterns (based on `expires_at`)

### Telegram notifications
Background workers send summaries via Telegram when they act on memory:
- "Consolidated 3 overlapping patterns about X → single pattern"
- "Deprecated 2 stale patterns (not seen in 90+ days): ..."
- "Active pattern count: 28/40"

## Implementation Phases (Delivered)

| Phase | What | Schema changes |
|-------|------|---------------|
| 1 | Kind simplification (9 → 3) + prod data cleanup | Migration: remap kinds, update constraint |
| 2 | MCP tools (`remember`, `save_chat`, `recall`, `reflect`) + extraction pipeline refactor | New tool specs |
| 3 | Decouple compaction from memory — pure context trimming, agent calls `remember` | Compaction summary storage |
| 4 | Retrieval improvements — lower thresholds, hybrid RRF | None |
| 5 | Shared soul state — global singleton | New `soul_state` table |
| 6 | Automated consolidation + Telegram notifications | None |

All phases shipped and deployed.

## Files Added/Modified

**Added files:**
- `src/tools/remember.ts` — MCP remember tool
- `src/tools/save-chat.ts` — MCP save_chat tool
- `src/tools/recall.ts` — MCP recall tool
- `src/tools/reflect.ts` — MCP reflect tool
- `src/memory/extraction.ts` — Shared extraction pipeline (refactored from agent.ts)
- `src/memory/consolidation.ts` — Cluster detection, LLM merge, cap enforcement

**Modified files:**
- `specs/tools.spec.ts` — 4 new tool specs
- `specs/schema.sql` — Update kind constraint, add `soul_state` table
- `scripts/migrate.ts` — Kind remap migration, soul state migration
- `src/server.ts` — Register new tools
- `src/db/queries.ts` — Updated decay params, text search query, consolidation queries, global soul CRUD
- `src/telegram/agent.ts` — Simplified compaction, `remember` in tool list, updated system prompt, retrieval thresholds
- `src/telegram/soul.ts` — Read/write global `soul_state`
- `src/transports/http.ts` — Wire consolidation into sync timer

## Existing Code to Reuse

| Component | Location | Reuse |
|-----------|----------|-------|
| Pattern extraction prompt | `telegram/agent.ts` lines 1414-1443 | Refactor into `memory/extraction.ts` |
| Dedup pipeline | `telegram/agent.ts` lines 1512-1631 | Refactor into `memory/extraction.ts` |
| `searchPatterns()` scoring | `db/queries.ts` lines 1802-1834 | Update decay params for 3 kinds |
| RRF merge | `tools/search.ts` | Pattern for hybrid retrieval |
| `buildSoulPromptSection()` | `telegram/soul.ts` | Reuse for MCP context injection |
| `sendMessage()` | `telegram/client.ts` | Consolidation notifications |
| Embedding pipeline | `db/embeddings.ts` | Shared embedding infrastructure |
| Optimistic locking | `db/queries.ts` artifact queries | Pattern for soul state writes |
