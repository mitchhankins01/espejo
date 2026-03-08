# Memory v2 — Memory Architecture & Shared Personality

## Status: Stub (awaiting spec worker)

## What

Combined redesign of the memory layer and creation of a shared personality layer that works across all interfaces (Telegram, Claude Desktop, future bots).

## Scope — Memory

- **Audit current pattern system**: What's working, what's not, where does it fall short?
- **Memory hierarchy**: entries (raw experience) → patterns (extracted semantics) → artifacts (synthesized knowledge) → ???
- **Research alternatives**: OpenClaw, MemGPT/Letta, other approaches to LLM long-term memory
- **Evaluate**: Is the problem the extraction quality? Retrieval quality? Decay model? Context injection format?

### Current Pattern System (for audit)

- 9 pattern kinds: behavior, emotion, belief, goal, preference, temporal, causal, fact, event
- Typed decay scoring per kind
- Extraction during compaction (size-based >48k chars OR time-based 12+ hours, 10+ messages)
- Dedup: canonical hash (exact) + ANN embedding similarity (0.82+ threshold)
- Retrieval: semantic search → MMR reranking → budget cap (2000 tokens) → system prompt injection
- Tables: `patterns`, `pattern_observations`, `pattern_relations`, `pattern_aliases`, `pattern_entries`

## Scope — Shared Personality

- **Current state**: Soul state is per-chat in Telegram only (`chat_soul_state` table)
- **"Higher self" concept**: Personality represents who you are at your core / want to be, not just bot behavior
- **Shared state**: Accessible across Telegram bot, Claude Desktop (via MCP), future interfaces
- **Read vs write**: How personality state is read (injected into any system prompt) vs written (evolved by any interface)
- **Conflict resolution**: If two interfaces evolve the soul state simultaneously

## Key Questions

### Memory
- What specifically feels broken about current memory? (Needs diagnostic data from actual usage)
- Is the extraction prompt producing high-quality patterns?
- Is retrieval surfacing the right patterns at the right time?
- Are decay curves well-calibrated? Are important patterns fading too fast?
- What does OpenClaw/MemGPT/Letta do differently that's worth adopting?
- Should memory be tiered (working → short-term → long-term) with different storage/retrieval?

### Personality
- Should personality live in the DB (current approach) or as a synced config/prompt file?
- How does Claude Desktop access personality state — new MCP tools (`get_soul_state`, `evolve_soul`)?
- What prevents personality drift when multiple interfaces write concurrently?
- How much of the soul state is "identity" (stable) vs "mood" (ephemeral)?

## Context Budget Note

Memory v2 should explicitly define token budgets per memory layer in the system prompt. Consider:
- Fixed allocation per section (e.g., 500 tokens for patterns, 300 for soul, 200 for recent context)
- Dynamic allocation based on relevance to current conversation
- Demand-pulled (agent requests what it needs) vs always-injected

## Dependencies

**This is the foundational spec** — all other specs build on decisions made here:
- Insight Engine (spec 1) uses memory/embeddings for dot-connecting
- Chat Archive (spec 2) storage target depends on memory layers
- Proactive Check-ins (spec 4) generate data that feeds into memory
- Project Management (spec 5) project state becomes part of agent context

## Existing Code to Reuse

| Component | Location | What to reuse/audit |
|-----------|----------|---------------------|
| Soul state | `telegram/soul.ts` | Current implementation to generalize |
| Soul evolution | `telegram/soul.ts` | `buildSoulCompactionContext()`, mutation logic |
| Pulse/quality loop | `telegram/pulse.ts` | `diagnoseQuality()`, `applySoulRepairs()` |
| Pattern extraction | `telegram/agent.ts` | Compaction pipeline, extraction prompts |
| Pattern retrieval | `telegram/agent.ts` | Semantic search → MMR → budget cap |
| Pattern tables | `db/queries.ts` | All pattern CRUD queries |
| Embedding pipeline | `db/embeddings.ts` | Shared embedding infrastructure |

## Research Tasks

- [ ] Audit pattern extraction quality from recent compactions
- [ ] Audit pattern retrieval relevance (are the right memories surfacing?)
- [ ] Measure current system prompt size with all context sections active
- [ ] Review OpenClaw architecture and applicability
- [ ] Review MemGPT/Letta memory tiering approach
- [ ] Review academic literature on LLM long-term memory (see `specs/ltm-research.md`)

## Open Design Decisions

- [ ] Memory hierarchy: how many layers, what lives where
- [ ] Extraction: current compaction-based vs continuous vs hybrid
- [ ] Retrieval: current MMR approach vs alternatives
- [ ] Decay: current typed decay vs usage-based vs hybrid
- [ ] Personality: DB-stored vs file-based vs hybrid
- [ ] Personality: per-interface vs shared vs both (shared core + per-interface overlay)
- [ ] Conflict resolution for concurrent personality writes
- [ ] Context budget framework: fixed vs dynamic vs demand-pulled
