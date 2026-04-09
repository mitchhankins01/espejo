---
title: "feat: Deduplicate extracted insights via embedding similarity"
type: feat
status: completed
date: 2026-04-09
origin: docs/brainstorms/2026-04-09-insight-dedup-brainstorm.md
---

# feat: Deduplicate extracted insights via embedding similarity

After `extractInsightsFromReview` produces candidate insights, check each against existing `kind='insight'` artifacts using cosine similarity on embeddings. Duplicates (similarity > 0.92) are still stored but marked with `duplicate_of` linking to the original. No LLM in the dedup loop — purely embedding + SQL. (see brainstorm: docs/brainstorms/2026-04-09-insight-dedup-brainstorm.md)

## Acceptance Criteria

- [x] New insights are embedded inline before R2 write (~$0.00001/each via `text-embedding-3-small`)
- [x] Each candidate is checked against existing `kind='insight'` artifacts with `embedding IS NOT NULL` using cosine similarity ≥ 0.92
- [x] Intra-batch dedup: candidates in the same extraction run are also checked against each other in memory
- [x] Duplicates are written to R2 with `duplicate_of: <original_artifact_id>` in frontmatter
- [x] Obsidian sync propagates `duplicate_of` from frontmatter to DB column
- [x] Telegram notification distinguishes "New insight: X" vs "Duplicate of existing: Y"
- [x] Embedding failure = fail-open (write as new, log warning)
- [x] `pnpm check` passes (types, lint, tests, coverage)

## Implementation

### 1. Migration: add `duplicate_of` column

**File:** `specs/schema.sql` + new migration file

```sql
ALTER TABLE knowledge_artifacts
  ADD COLUMN duplicate_of UUID REFERENCES knowledge_artifacts(id) ON DELETE SET NULL;
```

`ON DELETE SET NULL` handles original deletion gracefully — duplicates become standalone insights automatically.

### 2. New query: `findDuplicateInsightByEmbedding`

**File:** `src/db/queries/artifacts.ts`

Modeled on `findSimilarPatterns` in `patterns.ts:163` (accepts raw embedding vector, not artifact ID):

```sql
SELECT id, title, 1 - (embedding <=> $1::vector) AS similarity
FROM knowledge_artifacts
WHERE kind = 'insight'
  AND embedding IS NOT NULL
  AND deleted_at IS NULL
  AND 1 - (embedding <=> $1::vector) >= $2
ORDER BY embedding <=> $1::vector
LIMIT 1
```

Parameters: `(pool, embedding: number[], minSimilarity: number)` → returns `{ id, title, similarity } | null`.

### 3. Extend extraction pipeline

**File:** `src/obsidian/extraction.ts`

In `extractInsightsFromReview`, after LLM extraction and before R2 write:

1. Batch-embed all candidate texts (`title + "\n\n" + body`) via `generateEmbeddingsBatch`
2. For each candidate:
   - Query `findDuplicateInsightByEmbedding(pool, embedding, 0.92)` — checks DB
   - Also check cosine similarity against previously-processed candidates in this batch (in-memory dot product)
   - If duplicate found: set `duplicateOf: { id, title }` on the `ExtractedInsight`
3. Pass `duplicateOf` through to `insightToMarkdown` which writes `duplicate_of: <id>` in frontmatter

**Extend `ExtractedInsight` interface** with `duplicateOf?: { id: string; title: string }`.

**Embed text format:** Must match `embedPending` which uses `title + "\n\n" + body` for artifacts (`src/db/embed-pending.ts:88`).

### 4. Update `insightToMarkdown`

**File:** `src/obsidian/extraction.ts` (line ~101)

Conditionally add `duplicate_of: <uuid>` to frontmatter when present.

### 5. Parser + sync propagation

**File:** `src/obsidian/parser.ts`

Add `duplicateOf?: string` to `ParsedNote` interface. Extract from frontmatter `duplicate_of` field.

**File:** `src/db/queries/obsidian.ts`

Extend `upsertObsidianArtifact` INSERT/UPDATE to include `duplicate_of` column.

### 6. Telegram notification

**File:** `src/obsidian/extraction.ts` (notification section ~line 241)

When formatting the Telegram message, check `duplicateOf` on each insight:
- Present: `"🔁 Duplicate of "<original_title>": <new_title>"`
- Absent: `"💡 <title>"`

### 7. Tests

**File:** `tests/tools/insight-dedup.test.ts` (new)

- Unique insight passes dedup check → written without `duplicate_of`
- Similar insight (similarity > 0.92) → written with `duplicate_of` pointing to original
- Two identical insights in same batch → second marked as duplicate of first (intra-batch)
- Embedding failure → insight written as new (fail-open)
- `findDuplicateInsightByEmbedding` query returns correct results with threshold filtering

Use deterministic embeddings from `specs/fixtures/seed.ts` helpers (`generateBaseEmbedding`, `addNoise`).

## Edge Cases & Decisions

| Edge case | Decision |
|---|---|
| Existing insight has `embedding IS NULL` (not yet embedded) | Missed by dedup — acceptable timing gap. Caught on next cycle once embedded. |
| Original insight later deleted | `ON DELETE SET NULL` auto-promotes duplicate to standalone |
| Same-batch duplicates | In-memory cosine check against already-processed candidates in batch |
| Embedding API failure | Fail-open: write as new, log warning |
| R2 filename collision (titles normalize to same name) | Pre-existing issue, out of scope for this feature |
| 0.92 threshold tuning | Store as named constant `DEDUP_SIMILARITY_THRESHOLD` for easy adjustment |

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-04-09-insight-dedup-brainstorm.md](docs/brainstorms/2026-04-09-insight-dedup-brainstorm.md) — threshold 0.92, insights-only scope, store-but-mark strategy
- Similarity query pattern: `src/db/queries/artifacts.ts:283` (`findSimilarArtifacts`)
- Raw embedding query pattern: `src/db/queries/patterns.ts:163` (`findSimilarPatterns`)
- Embedding generation: `src/db/embeddings.ts:52` (`generateEmbedding`)
- Extraction pipeline: `src/obsidian/extraction.ts:136` (`extractInsightsFromReview`)
- Parser: `src/obsidian/parser.ts:39` (`parseObsidianNote`)
- Sync upsert: `src/db/queries/obsidian.ts:93` (`upsertObsidianArtifact`)
