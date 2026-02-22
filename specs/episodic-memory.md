# Episodic Memory: `fact` and `event` Pattern Kinds

## Context

The Telegram chatbot extracts patterns during conversation compaction — recurring themes, behavioral observations, emotional tendencies. These are **thematic**: "User crashes after nicotine", "Prefers morning work". But specific facts and events are lost after compaction. If you say "remember that restaurant you mentioned last month?", the bot can't recall it because episodic details were never stored as patterns.

Adding `fact` and `event` kinds gives the bot episodic memory alongside its existing thematic memory. Facts are near-permanent ("partner's name is Ana"), events are time-bound ("visited Tokyo in November 2024"). Both integrate into the existing pattern infrastructure — same table, same retrieval, same dedup — with different decay characteristics.

## Current State: Pattern Memory System

### What exists today

The chatbot's long-term memory is built on extracted patterns. During compaction, Claude analyzes conversation history and extracts atomic patterns into the `patterns` table.

**7 pattern kinds** with typed decay scoring:

| Kind | Half-life | Floor | Purpose |
|------|-----------|-------|---------|
| `behavior` | 90 days | 0.45 | Habits, routines |
| `emotion` | 14 days | 0.15 | Feelings, moods (volatile) |
| `belief` | 90 days | 0.45 | Views, opinions |
| `goal` | 60 days | 0.35 | Intentions, objectives |
| `preference` | 90 days | 0.45 | Likes, dislikes |
| `temporal` | 365 days | 0.60 | Timing patterns |
| `causal` | 90 days | 0.45 | Cause-effect relationships |

**Scoring formula** (`src/db/queries.ts:searchPatterns`):

```
score = similarity
      × (floor + (1 - floor) × exp(-ln(2) × age_days / half_life))
      × (1 + 0.25 × min(ln(1 + strength), 2))
      × confidence
      × validity
```

**Retrieval pipeline** (`src/telegram/agent.ts:retrievePatterns`):
1. Embed user message via OpenAI
2. Semantic search: top-20 candidates from `patterns` table (cosine similarity + typed decay)
3. MMR reranking (lambda=0.7) for diversity
4. Budget cap: 2000 tokens (~8000 chars)
5. Inject into system prompt as `- [kind] content (confidence, times_seen)`

**Compaction triggers** (`src/telegram/agent.ts:compactIfNeeded`):
- Size-based: total uncompacted chars exceed ~48k (12,000 token budget)
- Time-based: 12+ hours since last compaction AND 10+ uncompacted messages
- Manual: `/compact` command (4+ messages minimum)

**Deduplication** (two tiers during extraction):
1. Canonical hash: SHA-256 of normalized content (exact match)
2. Embedding similarity: 0.82+ threshold auto-reinforces existing pattern + creates alias

### What's missing

The extraction prompt tells Claude to extract "behavioral patterns" — thematic observations about the user. It does not ask for:

- **Facts**: "User's partner is named Ana", "User lives in Barcelona", "User is allergic to shellfish"
- **Events**: "User visited Tokyo in November 2024", "User started a new job in January", "User had a dentist appointment on Tuesday"

After compaction, these details are gone. The bot can recall that the user "tends to feel anxious before travel" (behavioral pattern) but not that they "traveled to London last week" (event).

## Design: Add `fact` and `event` Kinds

### Approach

Reuse the existing `patterns` table and all its infrastructure. No schema migration needed — the `kind` column is `TEXT NOT NULL` with no CHECK constraint, validated only by the Zod enum at extraction time.

### New kinds

| Kind | Half-life | Floor | Purpose | Examples |
|------|-----------|-------|---------|----------|
| `fact` | 3650 days (10y) | 0.85 | Permanent biographical details | Partner's name, city, job, allergies, native language |
| `event` | 60 days | 0.25 | Time-bound occurrences | Visited a place, started a job, attended an event, had an appointment |

**Why these decay parameters:**

- **Facts** are near-permanent. "Partner's name is Ana" doesn't become less relevant with time. The 10-year half-life and 0.85 floor mean a fact's recency multiplier stays above 0.85 essentially forever. Relevance is driven almost entirely by semantic similarity to the current query.

- **Events** are time-bound. "Visited restaurant X last week" is highly relevant now, moderately relevant next month, and marginally relevant next year. The 60-day half-life matches the natural decay of event salience. The 0.25 floor keeps old events minimally visible for life-history queries ("tell me about my travels").

### Disambiguation rules (for extraction prompt)

- Prefer `fact` over `belief` for concrete biographical details
- Prefer `event` over `temporal` for specific one-time occurrences
- `temporal` remains for recurring timing patterns ("user exercises on Mondays")

## Implementation Plan

### 1. `src/telegram/agent.ts`

**Bump max patterns** (line 59):
```typescript
const MAX_NEW_PATTERNS_PER_COMPACTION = 7; // was 5
```

**Expand Zod enum** (line 457):
```typescript
kind: z.enum(["behavior", "emotion", "belief", "goal", "preference", "temporal", "causal", "fact", "event"])
```

**Update extraction prompt** (lines 541-565):
- Title: "patterns, facts, and events" (was "behavioral patterns")
- Add kind guidelines section explaining when to use `fact` vs `event` vs existing kinds
- Update JSON schema line to include `fact|event`

### 2. `src/db/queries.ts`

**Add decay CASE branches** (lines 779-788):
```sql
WHEN 'fact' THEN 3650 WHEN 'event' THEN 60    -- half_life
WHEN 'fact' THEN 0.85 WHEN 'event' THEN 0.25  -- floor_val
```

### 3. `specs/fixtures/seed.ts`

Add 2 fixture patterns with pre-computed embeddings:
- `kind: "fact"` — "User's partner is named Ana."
- `kind: "event"` — "User moved to Barcelona in early 2024."

### 4. Tests

**Unit** (`tests/tools/telegram-agent.test.ts`):
- fact/event patterns injected into system prompt with correct `[fact]`/`[event]` labels
- fact/event kinds extracted during compaction and passed to `insertPattern`

**Integration** (`tests/integration/queries.test.ts`):
- `searchPatterns` returns valid scores for `fact` and `event` kinds using fixture embeddings

### What doesn't change

- **No migration** — `kind` is `TEXT` with no CHECK constraint
- **No formatter changes** — `buildSystemPrompt` uses `p.kind` directly
- **No dedup changes** — canonical hash + 0.82 ANN similarity works for all kinds
- **No MMR/budget changes** — diversity and capping are kind-agnostic
- **No retrieval pipeline changes** — patterns of all kinds flow through the same path

## Files

| File | Change |
|------|--------|
| `src/telegram/agent.ts` | Bump max patterns 5→7, expand Zod enum, update extraction prompt |
| `src/db/queries.ts` | Add `fact`/`event` CASE branches in `searchPatterns` decay scoring |
| `specs/fixtures/seed.ts` | Add 2 fixture patterns with new kinds |
| `tests/tools/telegram-agent.test.ts` | Tests for fact/event injection and extraction |
| `tests/integration/queries.test.ts` | Integration test for decay scoring with new kinds |

## Verification

`pnpm check` passes (359+ tests, 100% coverage). Then in prod:
1. Have a conversation mentioning personal facts and events
2. Send `/compact` to force pattern extraction
3. Query production DB: `SELECT kind, content, confidence FROM patterns WHERE kind IN ('fact', 'event')`
4. Start a new conversation referencing those facts/events — verify bot recalls them

## Future Considerations

- **Retroactive reclassification**: Existing patterns stored as `behavior` or `belief` that are really facts won't be automatically reclassified. Over time, new observations of the same fact will reinforce the existing pattern via ANN dedup. A one-time SQL update could fix historical data if needed.
- **Event temporal metadata**: The `temporal` JSONB column could store structured timestamps for events (e.g., `{"date": "2024-11-15"}`) to enable time-range queries. Not in v1.
- **Auto-purge**: `purgeCompactedMessages` exists in `queries.ts` but isn't wired up. Could be called after compaction to hard-delete messages older than 7 days, keeping the Railway DB lean.
