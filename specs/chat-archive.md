# Chat Archive — Save Command for Claude Desktop

## Status: Stub (awaiting spec worker)

## What

MCP tool (`save_chat` or similar) that captures a Claude Desktop conversation, extracts valuable content, embeds it, and stores it — but only if it adds genuinely new information.

## Scope

- **MCP tool interface**: What does the client send? (Claude Desktop would need a prompt to dump conversation content)
- **Extraction/transformation**: Raw chat → distilled insights, decisions, code snippets, facts
- **Dedup strategy**: Embedding similarity against existing entries + artifacts + patterns (threshold TBD)
- **Storage target**: New content type? Artifact kind? Separate table? Conversations have different structure/lifecycle than journal entries or knowledge artifacts
- **"New" means**: Semantic novelty check via cosine distance against nearest existing content

## Key Questions

- What prompt instructs Claude Desktop to serialize the conversation?
- Should extraction happen client-side (Claude Desktop does the summarization) or server-side (raw messages sent, server extracts)?
- What's the dedup threshold — how similar is "too similar to store"?
- Does this create artifacts, entries, or a new content type?
- How does the user trigger this? Explicit command? Auto-save on conversation end?
- What metadata to capture: timestamp, topic, tools used, duration?

## Dependencies

- **Memory v2** (spec 3) — storage target depends on what memory layers exist
- Otherwise relatively self-contained; can proceed in parallel with Memory v2 research

## Existing Code to Reuse

| Component | Location | What to reuse |
|-----------|----------|---------------|
| Artifact CRUD | `db/queries.ts` | Create/update artifact queries |
| Embedding pipeline | `db/embeddings.ts` | OpenAI embedding generation |
| RRF search | `tools/search.ts`, `db/queries.ts` | Dedup checking via similarity search |
| Pattern extraction prompt | `telegram/agent.ts` | Compaction prompt reusable for chat extraction |
| MCP tool registration | `server.ts`, `specs/tools.spec.ts` | Tool spec + registration pattern |

## Open Design Decisions

- [ ] Client-side vs server-side extraction
- [ ] Storage model: artifact kind, new table, or extension of existing type
- [ ] Dedup threshold (cosine similarity cutoff)
- [ ] Granularity: one record per conversation or multiple per topic/insight?
- [ ] How to handle conversations that span multiple topics
- [ ] Retention policy: do archived chats expire or persist forever?
