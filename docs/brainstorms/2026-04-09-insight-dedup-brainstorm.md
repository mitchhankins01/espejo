# Brainstorm: Insight Deduplication via Embedding Similarity

**Date:** 2026-04-09
**Status:** Ready for planning

## What We're Building

Post-extraction deduplication for insights generated from evening reviews. After `extractInsightsFromReview` produces candidate insights, each one is checked against existing `kind='insight'` artifacts using cosine similarity on embeddings. If a match exceeds the threshold, the new insight is still stored but marked as a duplicate with a link to the original.

This replaces reliance on the LLM prompt's "please don't duplicate" instruction with a deterministic, cheap similarity check.

## Why This Approach

- **Cost:** Embedding one insight via `text-embedding-3-small` costs ~$0.00001. Even checking against 1,000 existing insights is a single SQL query using the existing IVFFLAT index — no LLM call needed.
- **Accuracy:** Cosine similarity at 0.92 threshold catches same-idea-different-words without flagging merely related insights.
- **Infrastructure exists:** `knowledge_artifacts` already has `embedding vector(1536)` with an IVFFLAT index, and `findSimilarArtifacts()` in `artifacts.ts` already does cosine similarity queries.

## Key Decisions

1. **Duplicate handling:** Store the duplicate artifact normally but mark it with `duplicate_of` metadata (frontmatter flag or DB field) linking to the original insight's ID. It still appears in the vault but is clearly flagged.
2. **Similarity method:** Embedding cosine similarity only (no tsvector pre-filter). One OpenAI embedding call per candidate insight, then a single indexed SQL query against existing insights.
3. **Threshold:** 0.92 cosine similarity. Above this = duplicate.
4. **Scope:** Only compare against `kind='insight'` artifacts. Reviews naturally contain the same ideas as their extracted insights, so cross-kind comparison would produce false positives.
5. **No LLM in the loop:** The dedup check is purely embedding + SQL. The existing LLM prompt hint for context is kept as a soft signal but the hard check is post-extraction.

## Approach

1. After `extractInsightsFromReview` returns candidate insights, for each candidate:
   - Generate its embedding inline (single OpenAI call using `text-embedding-3-small`)
   - Query `knowledge_artifacts` for `kind='insight'` where cosine similarity > 0.92, ordered by similarity DESC, LIMIT 1
   - If a match is found: write the insight to R2 with `duplicate_of: <original_id>` in frontmatter
   - If no match: write normally
2. When the Obsidian sync picks up the file, the `duplicate_of` frontmatter is preserved in the artifact record
3. Telegram notification distinguishes duplicates: "New insight: X" vs "Duplicate of existing: Y"

## Open Questions

None — all key decisions resolved.
