# Insight Engine — Background Dot-Connecting Worker

## Status: Stub (awaiting spec worker)

## What

Scheduled background worker that scans all available data (entries, patterns, artifacts, Oura biometrics, todos) and surfaces non-obvious connections via Telegram notifications.

## Scope

- **Scheduling**: In-process `setInterval` like Oura sync, or separate process
- **"Connecting dots" concretely**:
  - Embedding similarity across recent entries vs historical
  - Pattern co-occurrence across time
  - Oura-journal correlations (e.g., poor sleep → negative journaling)
  - Temporal patterns ("you wrote about X last November too")
  - Todo staleness detection / progress stalls
- **Notification delivery**: Via Telegram (reuse existing `telegram/client.ts`)
- **Dedup/throttling**: Don't spam with low-value insights — cadence limits, relevance thresholds
- **Storage**: Log generated insights? Feed them back as patterns or artifacts?

## Key Questions

- What scoring/threshold determines "interesting enough to notify"?
- Should insights be stored (new table? artifact kind?) or ephemeral?
- How does it avoid being annoying — cadence limits, relevance thresholds, user feedback loop?
- What's the minimum viable insight that's actually useful?

## Context Budget Note

Generated insights injected into Telegram context could compound with existing Oura/todo/pattern injection. This spec must define a token budget for insight context — likely a fixed cap with priority ranking.

## Dependencies

- **Memory v2** (spec 3) — informs what memory layers exist and how retrieval works
- Uses embeddings/search infrastructure that Memory v2 may redesign

## Existing Code to Reuse

| Component | Location | What to reuse |
|-----------|----------|---------------|
| Sync scheduling | Oura sync (`oura/sync.ts`) | `setInterval` + PG advisory lock pattern |
| Embedding search | `db/queries.ts` | Cosine similarity queries, RRF search |
| Telegram delivery | `telegram/client.ts` | `sendMessage` with retry/chunking |
| Pattern retrieval | `telegram/agent.ts` | Semantic search → MMR reranking pipeline |
| Oura data | `oura/analysis.ts` | Correlation, trend, anomaly detection functions |
| Todo context | `todos/context.ts` | Current todo state summarization |

## Open Design Decisions

- [ ] Scheduling: in-process timer vs cron vs event-driven
- [ ] Insight types taxonomy and scoring rubric
- [ ] Storage model: new table, artifact kind, or ephemeral
- [ ] User feedback mechanism (thumbs up/down? dismiss? "more like this"?)
- [ ] Notification cadence limits (max N per day? per hour?)
